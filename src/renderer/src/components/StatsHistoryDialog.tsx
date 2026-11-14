import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { ChartLine, LoaderCircle, Trash2, X } from 'lucide-react';
import type { Connection, Entry, FolderStats } from '../../../shared/types';
import { formatDuration } from '../../../shared/folder-stats';
import { storageUri } from '../../../shared/storage-uri';
import { formatBytes, formatDate } from '../model';

interface Props { connection: Connection; entry: Entry; onClose(): void }
type GraphRange = 'all' | '24h' | '7d' | 'custom';

function TrendChart({ points, startAt, endAt, showSize, showCount, onToggleSize, onToggleCount, onSelectRange }: { points: FolderStats[]; startAt?: number; endAt?: number; showSize: boolean; showCount: boolean; onToggleSize(): void; onToggleCount(): void; onSelectRange(from: number, to: number): void }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [selection, setSelection] = useState<{ startX: number; endX: number } | null>(null);
  const drag = useRef<{ pointerId: number; startX: number } | null>(null);
  const left = 85, right = 615, top = 36, bottom = 198;
  const times = points.map(point => Date.parse(point.updatedAt));
  const first = startAt ?? times[0], last = endAt ?? times.at(-1)!;
  const domainStart = first === last ? first - 12 * 60 * 60 * 1000 : first;
  const domainEnd = first === last ? last + 12 * 60 * 60 * 1000 : last;
  const sizeMaximum = Math.max(...points.map(point => point.totalSize), 1);
  const countMaximum = Math.max(...points.map(point => point.fileCount), 1);
  const x = (index: number) => left + (right - left) * (times[index] - domainStart) / (domainEnd - domainStart);
  const y = (value: number, maximum: number) => bottom - (bottom - top) * value / maximum;
  const coordinates = points.map((point, index) => ({
    point,
    x: x(index),
    sizeY: y(point.totalSize, sizeMaximum),
    countY: y(point.fileCount, countMaximum),
  }));
  const onMouseMove = (event: MouseEvent<SVGSVGElement>) => {
    if (drag.current) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const mouseX = (event.clientX - rect.left) * 700 / rect.width;
    const mouseY = (event.clientY - rect.top) * 222 / rect.height;
    let nearest = -1, distance = Infinity;
    for (const metric of ['sizeY', 'countY'] as const) {
      if ((metric === 'sizeY' && !showSize) || (metric === 'countY' && !showCount)) continue;
      for (let index = 0; index < coordinates.length; index++) {
        const start = coordinates[index], end = coordinates[Math.min(index + 1, coordinates.length - 1)];
        const dx = end.x - start.x, dy = end[metric] - start[metric];
        const ratio = dx || dy ? Math.max(0, Math.min(1, ((mouseX - start.x) * dx + (mouseY - start[metric]) * dy) / (dx * dx + dy * dy))) : 0;
        const current = (mouseX - start.x - ratio * dx) ** 2 + (mouseY - start[metric] - ratio * dy) ** 2;
        if (current < distance) { distance = current; nearest = ratio > 0.5 ? Math.min(index + 1, coordinates.length - 1) : index; }
      }
    }
    setHoveredIndex(distance <= 14 ** 2 ? nearest : null);
  };
  const pointerPosition = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return { x: (event.clientX - rect.left) * 700 / rect.width, y: (event.clientY - rect.top) * 222 / rect.height };
  };
  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || drag.current) return;
    const position = pointerPosition(event);
    if (!position || position.x < left || position.x > right || position.y < top || position.y > bottom) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startX: position.x };
    setSelection({ startX: position.x, endX: position.x });
    setHoveredIndex(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const position = pointerPosition(event);
    if (position) setSelection({ startX: drag.current.startX, endX: Math.max(left, Math.min(right, position.x)) });
  };
  const finishDrag = (event: PointerEvent<SVGSVGElement>, cancelled: boolean) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const startX = drag.current.startX;
    const position = pointerPosition(event);
    const endX = position ? Math.max(left, Math.min(right, position.x)) : startX;
    drag.current = null;
    setSelection(null);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled || Math.abs(endX - startX) < 8) return;
    const toTime = (positionX: number) => domainStart + (positionX - left) * (domainEnd - domainStart) / (right - left);
    onSelectRange(Math.floor(toTime(Math.min(startX, endX)) / 1000) * 1000, Math.ceil(toTime(Math.max(startX, endX)) / 1000) * 1000);
  };
  const hovered = hoveredIndex === null || (!showSize && !showCount) ? null : coordinates[hoveredIndex];
  const chartLabel = showSize && showCount ? 'Total size and file count over time' : showSize ? 'Total size over time' : showCount ? 'File count over time' : 'No statistics lines shown';
  return <section className="stats-history-chart">
    <div className="stats-history-chart-heading"><h3>Folder trend</h3><div className="stats-history-legend">
      <button type="button" aria-pressed={showSize} className="stats-history-legend-item" onClick={() => { onToggleSize(); setHoveredIndex(null); }}><i className="stats-history-swatch size" aria-hidden="true" />Total size <strong>{formatBytes(points.at(-1)!.totalSize)}</strong></button>
      <button type="button" aria-pressed={showCount} className="stats-history-legend-item" onClick={() => { onToggleCount(); setHoveredIndex(null); }}><i className="stats-history-swatch count" aria-hidden="true" />File count <strong>{points.at(-1)!.fileCount.toLocaleString()} files</strong></button>
    </div></div>
    <div className="stats-history-plot"><svg role="img" aria-label={chartLabel} viewBox="0 0 700 222" onMouseMove={onMouseMove} onMouseLeave={() => setHoveredIndex(null)} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={event => finishDrag(event, false)} onPointerCancel={event => finishDrag(event, true)}>
      {[top, (top + bottom) / 2, bottom].map(position => <line key={position} x1={left} y1={position} x2={right} y2={position} className="stats-history-grid" />)}
      {showSize && <>
      <text x={left - 8} y={top + 4} textAnchor="end" className="stats-history-tick size">{formatBytes(sizeMaximum)}</text>
      <text x={left - 8} y={(top + bottom) / 2 + 4} textAnchor="end" className="stats-history-tick size">{formatBytes(sizeMaximum / 2)}</text>
      <text x={left - 8} y={bottom + 4} textAnchor="end" className="stats-history-tick size">0 B</text>
      </>}
      {showCount && <>
      <text x={right + 8} y={top + 4} textAnchor="start" className="stats-history-tick count">{countMaximum.toLocaleString()}</text>
      <text x={right + 8} y={(top + bottom) / 2 + 4} textAnchor="start" className="stats-history-tick count">{(countMaximum / 2).toLocaleString(undefined, { maximumFractionDigits: 1 })}</text>
      <text x={right + 8} y={bottom + 4} textAnchor="start" className="stats-history-tick count">0</text>
      </>}
      {coordinates.length > 1 && <>
        {showSize && <polyline points={coordinates.map(item => `${item.x},${item.sizeY}`).join(' ')} fill="none" stroke="#4f83da" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
        {showCount && <polyline points={coordinates.map(item => `${item.x},${item.countY}`).join(' ')} fill="none" stroke="#37a79a" strokeWidth="2.5" strokeDasharray="6 5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />}
      </>}
      {showSize && coordinates.map((item, index) => <circle key={`size:${item.point.updatedAt}:${index}`} cx={item.x} cy={item.sizeY} r="4" fill="#4f83da" stroke="#fff" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      {showCount && coordinates.map((item, index) => <circle key={`count:${item.point.updatedAt}:${index}`} cx={item.x} cy={item.countY} r="4" fill="none" stroke="#37a79a" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
      {selection && <rect className="stats-history-selection" x={Math.min(selection.startX, selection.endX)} y={top} width={Math.abs(selection.endX - selection.startX)} height={bottom - top} />}
    </svg>
    {hovered && <div role="tooltip" className="stats-history-tooltip" style={hovered.x < (left + right) / 2 ? { right: 12 } : { left: 12 }}>
      <time dateTime={hovered.point.updatedAt}>{formatDate(hovered.point.updatedAt, true)}</time>
      {showSize && <div><span>Total size</span><strong>{formatBytes(hovered.point.totalSize)}</strong></div>}
      {showCount && <div><span>File count</span><strong>{hovered.point.fileCount.toLocaleString()} files</strong></div>}
    </div>}</div>
    <div className="stats-history-axis"><span>{formatDate(new Date(domainStart).toISOString(), true)}</span><span>{formatDate(new Date(domainEnd).toISOString(), true)}</span></div>
    <p className="stats-history-drag-hint">Drag across the graph to choose a time range.</p>
  </section>;
}

export function StatsHistoryDialog({ connection, entry, onClose }: Props) {
  const [points, setPoints] = useState<FolderStats[] | null>(null);
  const [graphRange, setGraphRange] = useState<GraphRange>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [showSize, setShowSize] = useState(true);
  const [showCount, setShowCount] = useState(true);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let active = true;
    void window.s3.statsHistory(connection.id, entry.key).then(history => {
      if (active) setPoints([...history].sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt)));
    }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not load statistics history.');
    });
    return () => { active = false; };
  }, [connection.id, entry.key]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const keyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && ['f', 'r'].includes(event.key.toLowerCase())) event.preventDefault();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') || []);
      const first = buttons[0], last = buttons.at(-1);
      if (!dialog.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keyDown);
    return () => {
      document.removeEventListener('keydown', keyDown);
      queueMicrotask(() => { if (previous?.isConnected && !document.querySelector('[aria-modal="true"]')) previous.focus(); });
    };
  }, [onClose]);

  const changeHistory = async (action: () => Promise<FolderStats[] | null>) => {
    if (busy) return;
    setBusy(true);
    setActionError('');
    try {
      const updated = await action();
      if (updated !== null) setPoints(updated);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not change statistics history.');
    } finally { setBusy(false); }
  };
  const now = Date.now();
  const lower = graphRange === '24h' ? now - 24 * 60 * 60 * 1000 : graphRange === '7d' ? now - 7 * 24 * 60 * 60 * 1000 : graphRange === 'custom' && from ? Date.parse(from) : -Infinity;
  const upper = graphRange === 'custom' ? to ? Date.parse(to) : Infinity : graphRange === 'all' ? Infinity : now;
  const invalidRange = lower > upper;
  const graphPoints = invalidRange ? [] : points?.filter(point => Date.parse(point.updatedAt) >= lower && Date.parse(point.updatedAt) <= upper) ?? [];
  const selectGraphRange = (start: number, end: number) => {
    const localDateTime = (timestamp: number) => {
      const date = new Date(timestamp);
      return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
    };
    setFrom(localDateTime(start));
    setTo(localDateTime(end));
    setGraphRange('custom');
  };

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialog} className="upload-dialog stats-history-dialog" role="dialog" aria-modal="true" aria-labelledby="stats-history-title">
      <header className="upload-heading"><div className="dialog-icon"><ChartLine size={23} strokeWidth={1.6} /></div><div><h2 id="stats-history-title">Statistics history</h2><p>Folder totals recorded during the last 30 days.</p></div><button ref={closeButton} className="icon-button" aria-label="Close statistics history" onClick={onClose}><X size={18} /></button></header>
      <p className="upload-destination" title={storageUri(connection, entry.key)}><span>Folder</span>{storageUri(connection, entry.key)}</p>
      <div className="stats-history-content">
        {actionError && <div className="form-error" role="alert">{actionError}</div>}
        {error ? <div className="form-error" role="alert">{error}</div> : points === null ? <p className="stats-history-state" role="status"><LoaderCircle size={15} className="spin" />Loading history…</p> : !points.length ? <p className="stats-history-state">No statistics recorded in the last 30 days. Use the row’s refresh button to record the first scan.</p> : <>
          <div className="stats-history-range">
            <label>Graph range<select value={graphRange} onChange={event => setGraphRange(event.target.value as GraphRange)}><option value="all">All saved scans</option><option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="custom">Custom range</option></select></label>
            {graphRange === 'custom' && <><label>From<input type="datetime-local" step="1" value={from} onChange={event => setFrom(event.target.value)} /></label><label>To<input type="datetime-local" step="1" value={to} onChange={event => setTo(event.target.value)} /></label></>}
            <span className="stats-history-range-note">Graph: {graphPoints.length} of {points.length} scans</span>
          </div>
          {invalidRange ? <p className="stats-history-state" role="alert">From must be before To.</p> : graphPoints.length ? <TrendChart points={graphPoints} startAt={Number.isFinite(lower) ? lower : undefined} endAt={Number.isFinite(upper) ? upper : undefined} showSize={showSize} showCount={showCount} onToggleSize={() => setShowSize(value => !value)} onToggleCount={() => setShowCount(value => !value)} onSelectRange={selectGraphRange} /> : <p className="stats-history-state">No scans in this graph range.</p>}
          <table className="stats-history-table"><caption>Recorded scans</caption><thead><tr><th scope="col">Scanned</th><th scope="col">Total size</th><th scope="col">Files</th><th scope="col">Duration</th><th scope="col">Action</th></tr></thead><tbody>{[...points].reverse().map((point, index) => <tr key={`${point.updatedAt}:${index}`}><td><time dateTime={point.updatedAt}>{formatDate(point.updatedAt, true)}</time></td><td title={`${point.totalSize.toLocaleString()} bytes`}>{point.totalSize.toLocaleString()} bytes</td><td>{point.fileCount.toLocaleString()}</td><td>{formatDuration(point.durationMs)}</td><td><button type="button" className="stats-history-delete" aria-label={`Delete scan result from ${formatDate(point.updatedAt, true)}`} disabled={busy} onClick={() => void changeHistory(() => window.s3.deleteStatsHistoryPoint(connection.id, entry.key, point))}><Trash2 size={13} />Delete</button></td></tr>)}</tbody></table>
        </>}
      </div>
      <footer className="upload-footer"><span>Saved scans for this folder only.</span><button type="button" className="button destructive" disabled={busy || !points?.length} onClick={() => void changeHistory(() => window.s3.clearStatsHistory(connection.id, entry.key))}>Clear all history</button></footer>
    </div>
  </div>;
}
