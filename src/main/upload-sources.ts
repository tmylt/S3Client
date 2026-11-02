import { lstat, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { UploadSources } from '../shared/types';

export function validateUploadSelection(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || value.length > 10_000 || value.some(path => typeof path !== 'string' || !isAbsolute(path) || path.length > 8192 || path.includes('\0'))) {
    throw new Error('Choose local files or folders to upload.');
  }
}

export async function listUploadSources(value: unknown): Promise<UploadSources> {
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 8192 || value.includes('\0')) throw new Error('Enter an absolute local folder path.');
  try {
    const directory = resolve(value);
    if (await realpath(directory) !== directory || !(await lstat(directory)).isDirectory()) throw new Error();
    const children = await readdir(directory, { withFileTypes: true });
    const entries = children.filter(child => child.isDirectory() || child.isFile()).map(child => ({
      name: child.name, path: join(directory, child.name), kind: child.isDirectory() ? 'folder' as const : 'file' as const,
    })).sort((left, right) => left.kind !== right.kind ? left.kind === 'folder' ? -1 : 1 : left.name.localeCompare(right.name, undefined, { numeric: true }));
    const parent = dirname(directory);
    return { directory, parent: parent === directory ? null : parent, entries };
  } catch { throw new Error('Could not open this folder. Check that it exists and you have permission to read it.'); }
}
