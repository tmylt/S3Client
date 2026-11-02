import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocateDownloadRoot, downloadPlan, ensureDownloadPath, safeSegments, uploadPlan } from '../src/main/transfer-paths';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof fs>(), realpath: vi.fn((await importOriginal<typeof fs>()).realpath) }));
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 's3-transfer-paths-')); directories.push(path); return path; }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('transfer paths', () => {
  it('infers each source type and preserves a mixed selection of files and folders', async () => {
    const base = await directory();
    const folder = join(base, 'selected folder');
    await mkdir(join(folder, 'nested'), { recursive: true });
    await mkdir(join(folder, 'empty'));
    await writeFile(join(base, 'single.txt'), 'file');
    await writeFile(join(folder, 'nested', 'child.txt'), 'child');
    const plan = await uploadPlan('remote/', [join(base, 'single.txt'), folder]);
    expect(plan.map(item => item.key).sort()).toEqual(['remote/selected folder/empty/', 'remote/selected folder/nested/child.txt', 'remote/single.txt']);
    expect(plan.find(item => item.key === 'remote/single.txt')?.size).toBe(4);
    expect(plan.find(item => item.key.endsWith('/child.txt'))?.rootPath).toBe(folder);
    expect(plan.find(item => item.key.endsWith('/empty/'))?.isDirectory).toBe(true);
  });
  it('creates the download root immediately but nested directories only as individual files start', async () => {
    const base = await directory();
    const root = await allocateDownloadRoot(base, 'adir', true, new Set());
    const plan = downloadPlan('prefix/adir/', root, [
      { key: 'prefix/adir/dfile', size: 4, isDirectory: false },
      { key: 'prefix/adir/bdir/cfile', size: 5, isDirectory: false },
      { key: 'prefix/adir/empty/', size: 0, isDirectory: true },
      { key: 'prefix/adir/bdir/', size: 0, isDirectory: true },
    ]);
    expect(await readdir(base)).toEqual(['adir']); expect(await readdir(root.path)).toEqual([]);
    await ensureDownloadPath(base, plan[0].localPath, false);
    expect(await readdir(root.path)).toEqual([]);
    await ensureDownloadPath(base, plan[1].localPath, false);
    expect(await readdir(root.path)).toEqual(['bdir']);
    expect(plan.filter(item => item.isDirectory).map(item => item.relativePath)).toEqual(['adir/empty/']);
    await ensureDownloadPath(base, plan[2].localPath, true);
    expect((await readdir(root.path)).sort()).toEqual(['bdir', 'empty']);
  });

  it('preserves existing local files and allocates unique names for reserved files and directories', async () => {
    const base = await directory(); await writeFile(join(base, 'file.txt'), 'keep'); await mkdir(join(base, 'adir'));
    const reservations = new Set([join(base, 'file (2).txt')]);
    expect((await allocateDownloadRoot(base, 'file.txt', false, reservations)).path).toBe(join(base, 'file (3).txt'));
    expect((await allocateDownloadRoot(base, 'adir', true, reservations)).path).toBe(join(base, 'adir (2)'));
    expect(await readFile(join(base, 'file.txt'), 'utf8')).toBe('keep');
  });

  it('rejects traversal, ambiguous paths, file/directory collisions and symlink parents', async () => {
    for (const key of ['../outside', '/outside', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'C:drive']) expect(() => safeSegments(key)).toThrow();
    expect(safeSegments('100% + #.txt')).toEqual(['100% + #.txt']);
    const base = await directory(); const outside = await directory();
    await symlink(outside, join(base, 'link'));
    await expect(ensureDownloadPath(base, join(base, 'link', 'file'), false)).rejects.toThrow(/symbolic|symlink/i);
    expect(() => downloadPlan('p/', { path: join(base, 'root'), name: 'root' }, [{ key: 'p/file', size: 1, isDirectory: false }, { key: 'p/file/child', size: 1, isDirectory: false }])).toThrow(/conflict/i);
    expect(() => downloadPlan('p/', { path: join(base, 'root'), name: 'root' }, [{ key: 'private/file', size: 1, isDirectory: false }])).toThrow(/outside/i);
  });

  it('plans uploads without following symlinks and retains selected root and empty folders', async () => {
    const base = await directory(); const root = join(base, 'adir'); await mkdir(join(root, 'bdir'), { recursive: true }); await mkdir(join(root, 'empty'));
    await writeFile(join(root, 'dfile'), 'data'); await writeFile(join(root, 'bdir', 'cfile'), 'child');
    const plan = await uploadPlan('remote/', [root]);
    expect(plan.map(item => item.key).sort()).toEqual(['remote/adir/bdir/cfile', 'remote/adir/dfile', 'remote/adir/empty/']);
    await symlink(join(root, 'dfile'), join(root, 'link'));
    await expect(uploadPlan('remote/', [root])).rejects.toThrow(/symbolic|symlink/i);
  });
  it('rejects a replaced ancestor above a persisted granted root before creating descendants', async () => {
    const base = await directory(); const outside = await directory(); await mkdir(join(outside, 'grant'));
    await symlink(outside, join(base, 'ancestor'));
    await expect(ensureDownloadPath(join(base, 'ancestor', 'grant'), join(base, 'ancestor', 'grant', 'nested', 'file'), false)).rejects.toThrow(/unsafe|symbolic|changed/i);
    expect(await readdir(join(outside, 'grant'))).toEqual([]);
  });

  it('does not recreate a vanished granted root while creating download parents', async () => {
    const base = await directory(); const root = join(base, 'grant'); await mkdir(root);
    const originalRealpath = (await vi.importActual<typeof fs>('node:fs/promises')).realpath;
    vi.spyOn(fs, 'realpath').mockImplementationOnce(async path => { const canonical = await originalRealpath(path); await rename(root, join(base, 'moved')); return canonical; });
    await expect(ensureDownloadPath(root, join(root, 'nested', 'file'), false)).rejects.toThrow(/unsafe|symbolic|changed/i);
    expect((await readdir(base)).sort()).toEqual(['moved']);
  });

  it('refuses a selected destination replaced with a symbolic link before allocation', async () => {
    const base = await directory(); const outside = await directory(); await symlink(outside, join(base, 'grant'));
    await expect(allocateDownloadRoot(join(base, 'grant'), 'folder', true, new Set())).rejects.toThrow(/unsafe|symbolic|changed/i);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses an upload source with a symbolic-link ancestor instead of canonicalizing a new grant', async () => {
    const base = await directory(); const outside = await directory(); await writeFile(join(outside, 'source'), 'private'); await symlink(outside, join(base, 'grant'));
    await expect(uploadPlan('root/', [join(base, 'grant', 'source')])).rejects.toThrow(/unsafe|symbolic|changed/i);
  });

});
