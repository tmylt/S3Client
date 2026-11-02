import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, type FileHandle } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export interface PlannedPath { key: string; size: number; isDirectory: boolean; localPath: string; rootPath: string; relativePath: string }
interface RemoteObject { key: string; size: number; isDirectory: boolean }

export function safeSegments(value: string): string[] {
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('An S3 name cannot be saved safely on this computer. Names containing traversal or incompatible path characters are not supported.');
  }
  return parts;
}

function within(root: string, target: string): string[] {
  const child = relative(root, target);
  if (!isAbsolute(root) || !isAbsolute(target) || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error('The local path is outside the selected directory.');
  return child ? child.split(sep) : [];
}

/** Node has no dir_fd calls. Linux procfs provides descriptor-relative lookups. */
export function descriptorPath(directory: FileHandle, leaf: string): string { return `/proc/self/fd/${directory.fd}/${leaf}`; }
export const safeLocalIOMessage = 'Safe local file access requires Linux with /proc/self/fd. The selected directory must be available and contain no symbolic links.';
export async function openDirectoryAnchor(root: string, target = root, create = false): Promise<FileHandle> {
  if (process.platform !== 'linux') throw new Error(safeLocalIOMessage);
  const parts = within(root, target);
  if (resolve(root) !== root || await realpath(root) !== root) throw new Error('The selected directory is unsafe or has changed to a symbolic link. Choose it again.');
  let anchor = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const walk = [...root.split('/').filter(Boolean).map(part => ({ part, mayCreate: false })), ...parts.map(part => ({ part, mayCreate: create }))];
    for (const { part, mayCreate } of walk) {
      const next = descriptorPath(anchor, part);
      let child: FileHandle;
      try { child = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
      catch (error) {
        if (!mayCreate || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await mkdir(next); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause; }
        child = await open(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      await anchor.close(); anchor = child;
    }
    return anchor;
  } catch { await anchor.close(); throw new Error(safeLocalIOMessage); }
}

/** Only execution calls this: discovery/planning never creates descendant paths. */
export async function ensureDownloadPath(root: string, target: string, directory: boolean): Promise<void> {
  for (const part of within(root, target)) safeSegments(part);
  const anchor = await openDirectoryAnchor(root, directory ? target : dirname(target), true);
  try {
    if (!directory) {
      try { await lstat(descriptorPath(anchor, basename(target))); throw new Error('A file already exists at the download destination. Choose a new destination or start another download.'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  } finally { await anchor.close(); }
}

export async function allocateDownloadRoot(base: string, name: string, directory: boolean, reserved: Set<string>): Promise<{ path: string; name: string }> {
  safeSegments(name);
  const root = await realpath(base);
  if (root !== base) throw new Error('The selected directory is unsafe or has changed to a symbolic link. Choose it again.');
  const anchor = await openDirectoryAnchor(root);
  try {
    const dot = !directory && name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length;
    for (let number = 1; number <= 10000; number++) {
      const next = number === 1 ? name : `${name.slice(0, dot)} (${number})${name.slice(dot)}`;
      const path = join(root, next);
      if (reserved.has(path)) continue;
      if (directory) {
        try { await mkdir(descriptorPath(anchor, next)); return { path, name: next }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue; throw error; }
      }
      try { await lstat(descriptorPath(anchor, next)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (reserved.has(path)) continue;
        reserved.add(path); return { path, name: next };
      }
    }
    throw new Error('Could not allocate an unused download name. Choose another destination.');
  } finally { await anchor.close(); }
}

export function downloadPlan(prefix: string, root: { path: string; name: string }, objects: RemoteObject[]): PlannedPath[] {
  const files: PlannedPath[] = [];
  const markers = new Map<string, PlannedPath>();
  const fileNames = new Set<string>();
  const parents = new Set<string>();
  const unique = new Set<string>();
  const identity = (path: string) => process.platform === 'linux' ? path : path.toLocaleLowerCase();
  for (const item of objects) {
    if (!item.key.startsWith(prefix)) throw new Error('The S3 service returned an object outside the requested folder.');
    if (!Number.isSafeInteger(item.size) || item.size < 0 || typeof item.isDirectory !== 'boolean') throw new Error('The S3 service returned invalid transfer metadata.');
    if (item.key === prefix) continue;
    const child = item.key.slice(prefix.length);
    const parts = safeSegments(item.isDirectory ? child.slice(0, -1) : child);
    if (item.isDirectory && !child.endsWith('/')) throw new Error('The S3 service returned an invalid folder marker.');
    const name = identity(parts.join('/'));
    if (unique.has(item.key)) continue;
    unique.add(item.key);
    for (let length = 1; length < parts.length; length++) parents.add(identity(parts.slice(0, length).join('/')));
    const plan = { key: item.key, size: item.isDirectory ? 0 : item.size, isDirectory: item.isDirectory, localPath: join(root.path, ...parts), rootPath: dirname(root.path), relativePath: `${root.name}/${parts.join('/')}${item.isDirectory ? '/' : ''}` };
    if (item.isDirectory) markers.set(name, plan);
    else { if (fileNames.has(name)) throw new Error('S3 names conflict on this computer.'); fileNames.add(name); files.push(plan); }
  }
  for (const name of fileNames) if (parents.has(name) || markers.has(name)) throw new Error('The S3 folder contains conflicting file and directory names.');
  return [...files, ...[...markers].filter(([name]) => !parents.has(name)).map(([, plan]) => plan)];
}

export async function validateUploadPath(root: string, path: string, directory = false): Promise<number> {
  const parts = within(root, path);
  let current = root;
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('The upload source directory is unsafe or unavailable.');
  for (const part of parts) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are not included in uploads. Choose regular files or folders.');
  }
  const info = await lstat(path);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error('The selected upload source is no longer available.');
  if (!Number.isSafeInteger(info.size) || info.size < 0) throw new Error('The upload source is too large.');
  return directory ? 0 : info.size;
}

export async function uploadPlan(prefix: string, paths: string[], signal?: AbortSignal): Promise<PlannedPath[]> {
  if (!paths.length || paths.some(path => !isAbsolute(path))) throw new Error('Choose upload files or folders.');
  const result: PlannedPath[] = [];
  const keys = new Set<string>();
  const check = () => { if (signal?.aborted) throw new Error('Upload preparation cancelled.'); if (result.length > 100_000) throw new Error('This upload contains too many files. Choose a smaller folder.'); };
  const add = async (path: string, root: string, display: string, directory: boolean) => {
    check(); const key = `${prefix}${display}${directory ? '/' : ''}`;
    if (keys.has(key)) throw new Error('The selected upload files contain duplicate names.'); keys.add(key);
    result.push({ key, size: await validateUploadPath(root, path, directory), isDirectory: directory, localPath: path, rootPath: root, relativePath: display + (directory ? '/' : '') });
  };
  const visit = async (path: string, root: string, display: string): Promise<void> => {
    check(); const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not included in uploads. Choose regular files or folders.');
    if (info.isFile()) { await add(path, root, display, false); return; }
    if (!info.isDirectory()) throw new Error('Only regular files and folders can be uploaded.');
    const children = await readdir(path);
    if (!children.length) await add(path, root, display, true);
    for (const child of children) await visit(join(path, child), root, `${display}/${child}`);
  };
  for (const path of paths) {
    check(); const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Symbolic links are not included in uploads.');
    if (!info.isDirectory() && !info.isFile()) throw new Error('Only regular files and folders can be uploaded.');
    const canonical = await realpath(path);
    if (canonical !== path) throw new Error('The selected upload source is unsafe or has changed to a symbolic link. Choose it again.');
    await visit(canonical, info.isDirectory() ? canonical : dirname(canonical), basename(path));
  }
  return result;
}
