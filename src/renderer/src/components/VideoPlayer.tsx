import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Film, Grip, LoaderCircle, Maximize, Minimize, X } from 'lucide-react';
import { formatBytes } from '../model';
import { defaultVideoPaneSize, loadVideoPaneSize, saveVideoPaneSize, type VideoPaneSize } from '../view-sizes';

interface Props { connectionId: string; objectKey: string; name: string; onClose(): void }

export function VideoPlayer({ connectionId, objectKey, name, onClose }: Props) {
  const [mode, setMode] = useState<'stream' | 'download' | null>(null);
  const [url, setURL] = useState('');
  const [received, setReceived] = useState(0);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [size, setSize] = useState(loadVideoPaneSize);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const sizeRef = useRef(size);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; size: VideoPaneSize } | null>(null);

  const resize = (next: VideoPaneSize, persist = false) => {
    const adjusted = {
      width: Math.max(480, Math.min(next.width, window.innerWidth - 48)),
      height: Math.max(280, Math.min(next.height, window.innerHeight - 48)),
    };
    sizeRef.current = adjusted;
    setSize(adjusted);
    if (persist) saveVideoPaneSize(adjusted);
  };

  const toggleFullscreen = async () => {
    setFullscreenError('');
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await dialogRef.current?.requestFullscreen();
    } catch {
      setFullscreenError('Could not enter fullscreen.');
    }
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (fullscreen) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, size: sizeRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    resize({ width: drag.size.width + event.clientX - drag.x, height: drag.size.height + event.clientY - drag.y });
  };

  const stopResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    saveVideoPaneSize(sizeRef.current);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? 50 : 20;
    const delta = event.key === 'ArrowRight' ? { width: step, height: 0 }
      : event.key === 'ArrowLeft' ? { width: -step, height: 0 }
      : event.key === 'ArrowDown' ? { width: 0, height: step }
      : event.key === 'ArrowUp' ? { width: 0, height: -step } : null;
    if (!delta) return;
    event.preventDefault();
    resize({ width: sizeRef.current.width + delta.width, height: sizeRef.current.height + delta.height }, true);
  };

  useEffect(() => {
    let active = true;
    let id: string | undefined;
    const unsubscribe = window.s3.onVideoEvent(event => {
      if (!active || event.id !== id) return;
      if (event.event === 'progress') { setReceived(event.received); setTotal(event.total); }
      else if (event.event === 'ready') { setReceived(event.total); setTotal(event.total); setURL(event.url); }
      else { setError(event.message); }
    });
    void (async () => {
      try {
        const opened = await window.s3.openVideo(connectionId, objectKey);
        if (!active) { await window.s3.closeVideo(opened.id); return; }
        id = opened.id;
        setMode(opened.mode);
        setTotal(opened.total);
        if (opened.mode === 'stream') setURL(opened.url || '');
        else await window.s3.startVideo(opened.id);
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : 'Could not open this video.');
      }
    })();
    return () => { active = false; unsubscribe(); if (id) void window.s3.closeVideo(id).catch(() => undefined); };
  }, [connectionId, objectKey]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); if (document.fullscreenElement) void document.exitFullscreen(); else onClose(); } };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);

  useEffect(() => {
    const changed = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  useEffect(() => window.s3.onResetViewSizes(() => resize(defaultVideoPaneSize)), []);

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="video-dialog" role="dialog" aria-modal="true" aria-label={`Play ${name}`} style={{ width: size.width, height: size.height }}>
      <header className="video-header"><Film size={17} /><div><h2 title={name}>{name}</h2><span>{fullscreenError || (mode === 'stream' ? 'Streaming from S3' : mode === 'download' ? url ? 'Temporary download ready' : 'Preparing a temporary download' : 'Checking video access')}</span></div><button className="icon-button" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} title={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize size={17} /> : <Maximize size={17} />}</button><button className="icon-button" aria-label="Close video" onClick={onClose}><X size={18} /></button></header>
      <div className="video-stage">
        {error ? <div className="video-message" role="alert"><Film size={29} /><p>{error}</p></div> : url ? <video src={url} controls autoPlay playsInline onError={() => setError('Could not play this MP4. The codec or stream may not be supported.')} /> : <div className="video-message" role="status"><LoaderCircle size={26} className="spin" /><p>{mode === 'download' ? 'Downloading the MP4 before playback…' : 'Preparing video…'}</p></div>}
      </div>
      {mode === 'download' && !url && !error && <div className="video-progress"><progress value={received} max={total || 1} /><span>{formatBytes(received)} of {formatBytes(total)}</span></div>}
      <div className="video-resize-footer"><button className="video-resize-handle" aria-label="Resize video player" title="Drag to resize; arrow keys also work" onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={stopResize} onPointerCancel={stopResize} onKeyDown={resizeWithKeyboard}><Grip size={14} /></button></div>
    </div>
  </div>;
}
