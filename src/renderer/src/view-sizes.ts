export const defaultSidebarWidth = 250;
const sidebarWidthKey = 's3-client.sidebar-width.v1';

export function loadSidebarWidth(): number {
  try {
    const saved = localStorage.getItem(sidebarWidthKey);
    if (saved !== null) {
      const width = Number(saved);
      if (Number.isInteger(width) && width >= 200 && width <= 420) return width;
    }
  } catch { /* Preferences are optional. */ }
  return defaultSidebarWidth;
}

export function saveSidebarWidth(width: number): void {
  if (!Number.isInteger(width) || width < 200 || width > 420) return;
  try { localStorage.setItem(sidebarWidthKey, String(width)); }
  catch { /* Resizing still works when local storage is unavailable. */ }
}

export function resetSidebarWidth(): void {
  try { localStorage.removeItem(sidebarWidthKey); }
  catch { /* The current window can still be reset. */ }
}

export interface VideoPaneSize { width: number; height: number }
export const defaultVideoPaneSize: VideoPaneSize = { width: 860, height: 480 };
const videoPaneSizeKey = 's3-client.video-pane-size.v1';

export function loadVideoPaneSize(): VideoPaneSize {
  try {
    const saved = JSON.parse(localStorage.getItem(videoPaneSizeKey) || 'null');
    if (Number.isInteger(saved?.width) && saved.width >= 480 && saved.width <= 3000 &&
      Number.isInteger(saved?.height) && saved.height >= 280 && saved.height <= 2000) return saved;
  } catch { /* Preferences are optional. */ }
  return { ...defaultVideoPaneSize };
}

export function saveVideoPaneSize(size: VideoPaneSize): void {
  try { localStorage.setItem(videoPaneSizeKey, JSON.stringify(size)); }
  catch { /* Resizing still works when local storage is unavailable. */ }
}

export function resetVideoPaneSize(): void {
  try { localStorage.removeItem(videoPaneSizeKey); }
  catch { /* The current window can still be reset. */ }
}
