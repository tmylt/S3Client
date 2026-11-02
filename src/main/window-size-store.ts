import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface WindowSize { width: number; height: number; maximized: boolean }
export const defaultWindowSize: WindowSize = { width: 1200, height: 800, maximized: false };

function valid(value: unknown): value is WindowSize {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const size = value as Partial<WindowSize>;
  return Number.isInteger(size.width) && size.width! >= 800 && size.width! <= 10000 &&
    Number.isInteger(size.height) && size.height! >= 560 && size.height! <= 10000 && typeof size.maximized === 'boolean';
}

/** Small, atomic geometry preference stored beside the connection settings. */
export class WindowSizeStore {
  private readonly file: string;

  constructor(private readonly directory: string) { this.file = join(directory, 'window-size.json'); }

  load(): WindowSize {
    try {
      const stat = statSync(this.file);
      if (!stat.isFile() || stat.size > 1024) return { ...defaultWindowSize };
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (valid(value)) return { width: value.width, height: value.height, maximized: value.maximized };
    } catch { /* Missing or damaged preferences use the standard size. */ }
    return { ...defaultWindowSize };
  }

  save(value: WindowSize): void {
    if (!valid(value)) throw new Error('Invalid window size.');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { try { unlinkSync(temporary); } catch { /* Renamed or already removed. */ } }
  }

  reset(): void { this.save(defaultWindowSize); }
}
