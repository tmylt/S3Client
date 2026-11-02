import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { listUploadSources, validateUploadSelection } from '../src/main/upload-sources';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('unified upload sources', () => {
  it('lists actual files and folders together with exact paths and skips symbolic links', async () => {
    const root = await mkdtemp(join(tmpdir(), 's3-upload-chooser-')); directories.push(root);
    await mkdir(join(root, 'folder (6)'));
    await writeFile(join(root, 'file + (6).txt'), 'data');
    await symlink(join(root, 'file + (6).txt'), join(root, 'link'));
    expect(await listUploadSources(root)).toEqual({ directory: root, parent: dirname(root), entries: [
      { name: 'folder (6)', path: join(root, 'folder (6)'), kind: 'folder' },
      { name: 'file + (6).txt', path: join(root, 'file + (6).txt'), kind: 'file' },
    ] });
    await expect(listUploadSources(join(root, 'link'))).rejects.toThrow(/Could not open/i);
    await expect(listUploadSources(join(root, 'missing'))).rejects.toThrow(/Could not open/i);
  });
  it('rejects invalid chooser paths and upload selections before accessing sources', async () => {
    for (const path of [null, [], '../relative', '/bad\0path']) await expect(listUploadSources(path)).rejects.toThrow(/absolute local/i);
    for (const value of [null, 'file', [], ['relative'], ['/bad\0path'], [12]]) expect(() => validateUploadSelection(value)).toThrow(/Choose local/i);
    expect(() => validateUploadSelection(['/local/file', '/local/folder'])).not.toThrow();
  });
});
