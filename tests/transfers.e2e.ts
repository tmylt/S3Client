import { test, expect, _electron, type ElectronApplication, type Page } from '@playwright/test';
import { captureTestScreenshot, showTestWindow } from './desktop-test-window';
import { mkdtemp, mkdir, open, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import type { TransferSnapshot } from '../src/shared/transfers';
import type { ConnectionPermissions } from '../src/shared/types';
import { LocalS3, adaptCopySourceForFixture, encodeListingXML, fixZeroRangeForFixture } from './s3-test-server';

const root = process.cwd();
const packagedExecutable = process.platform === 'linux' ? join(root, 'release/linux-unpacked/s3-client') : process.platform === 'win32' ? join(root, 'release/win-unpacked/S3 Client.exe') : join(root, `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/S3 Client.app/Contents/MacOS/S3 Client`);
const bucket = 'transfer-desktop-fixtures';
let ignoredDeleteKey: string | undefined;
let formEncodedListings = false;
let throttleHistoryUploads = false;
let historyUploadRequests = 0;
const fileBytes = Buffer.from([0, 255, 1, 128, ...Buffer.from('Exact real desktop download\n你好\n')]);
const topBytes = Buffer.from('top-level content\n');
const deepBytes = Buffer.from('deep nested content\n');
const initialObjects: ReadonlyArray<readonly [string, Buffer]> = [
  ['workspace/readme.bin', fileBytes], ['workspace/collection/dfile', topBytes], ['workspace/collection/bdir/cfile', deepBytes],
  ['workspace/collection/empty-leaf/', Buffer.alloc(0)], ['workspace/collection-neighbor/keep.txt', Buffer.from('neighbor survives')],
  ['workspace/trash.txt', Buffer.from('delete only this file')], ['workspace/restart.txt', Buffer.from('restart remains paused')],
  ['active/keep.txt', Buffer.from('completed files survive cancellation')], ['active/queued-one.txt', Buffer.from('one')], ['active/queued-two.txt', Buffer.from('two')],
  ['active/large.bin', Buffer.alloc(16 * 1024 * 1024, 'x')],
];
let service: LocalS3 | undefined;
let proxy: Server | undefined;
let directEndpoint: string;
let endpoint: string;
let fixtureDirectory: string;
let directory: string;
let profile: string;
let app: ElectronApplication | undefined;
let requests = 0;
let throttleLargeDownloads = false;
let errors: string[];

function isolatedEnvironment() {
  return {
    ...process.env,
    AWS_ACCESS_KEY_ID: 'transfer-test-access', AWS_SECRET_ACCESS_KEY: 'transfer-test-secret', AWS_SESSION_TOKEN: '',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_DEFAULT_REGION: 'us-east-1',
    AWS_CONFIG_FILE: join(fixtureDirectory, 'unused-aws-config'), AWS_SHARED_CREDENTIALS_FILE: join(fixtureDirectory, 'unused-aws-credentials'),
  };
}

async function remoteKeys(prefix: string): Promise<string[]> {
  return service!.keys(prefix);
}

async function remoteBytes(key: string): Promise<Buffer> {
  return service!.bytes(key);
}

test.beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), 's3-client-transfer-service-'));
  service = await LocalS3.start(bucket);
  directEndpoint = service.endpoint;

  // Only large.bin is paced. This makes stop/cancel observe actual written bytes,
  // independently of machine speed, without mocking the app's S3 APIs.
  proxy = createServer((incoming, outgoing) => {
    requests++;
    if (ignoredDeleteKey && incoming.method === 'DELETE' && decodeURIComponent(new URL(incoming.url || '/', directEndpoint).pathname) === `/${bucket}/${ignoredDeleteKey}`) {
      incoming.resume();
      outgoing.writeHead(204); outgoing.end();
      return;
    }
    const { authorization: _authorization, ...headers } = incoming.headers;
    if (typeof headers['x-amz-copy-source'] === 'string') headers['x-amz-copy-source'] = adaptCopySourceForFixture(headers['x-amz-copy-source']);
    const upstream = request(new URL(incoming.url || '/', directEndpoint), { method: incoming.method, headers: { ...headers, host: new URL(directEndpoint).host } }, response => {
      const url = new URL(incoming.url || '/', directEndpoint);
      if (incoming.headers.range === 'bytes=0-0' && response.statusCode === 206) {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const fixed = fixZeroRangeForFixture(response.headers, Buffer.concat(chunks));
          outgoing.writeHead(206, fixed.headers); outgoing.end(fixed.body);
        });
        response.on('error', () => outgoing.destroy());
        return;
      }
      if (url.searchParams.get('list-type') === '2' && url.searchParams.get('encoding-type') === 'url' && response.statusCode === 200) {
        // s3rver returns raw keys; emulate S3's URL encoding and optional form encoding.
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = encodeListingXML(Buffer.concat(chunks).toString('utf8'), formEncodedListings);
          const { 'transfer-encoding': _encoding, 'content-length': _length, ...forwarded } = response.headers;
          outgoing.writeHead(200, { ...forwarded, 'content-length': String(body.length) });
          outgoing.end(body);
        });
        response.on('error', () => outgoing.destroy());
        return;
      }
      outgoing.writeHead(response.statusCode || 502, response.headers);
      if (!throttleLargeDownloads || incoming.method !== 'GET' || !incoming.url?.split('?')[0].endsWith('/large.bin')) {
        response.pipe(outgoing);
        return;
      }
      void (async () => {
        try {
          for await (const chunk of response) {
            const bytes = Buffer.from(chunk);
            for (let offset = 0; offset < bytes.length && !outgoing.destroyed; offset += 32 * 1024) {
              outgoing.write(bytes.subarray(offset, offset + 32 * 1024));
              await delay(25);
            }
            if (outgoing.destroyed) break;
          }
          if (!outgoing.destroyed) outgoing.end();
        } catch { outgoing.destroy(); }
      })();
    });
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => upstream.destroy());
    if (throttleHistoryUploads && incoming.method === 'PUT' && incoming.url?.split('?')[0].includes('/row-removal-')) {
      historyUploadRequests++;
      void (async () => {
        try {
          for await (const chunk of incoming) {
            const bytes = Buffer.from(chunk);
            for (let offset = 0; offset < bytes.length && !upstream.destroyed; offset += 32 * 1024) {
              upstream.write(bytes.subarray(offset, offset + 32 * 1024));
              await delay(20);
            }
            if (upstream.destroyed) break;
          }
          if (!upstream.destroyed) upstream.end();
        } catch { upstream.destroy(); outgoing.destroy(); }
      })();
    } else incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { proxy!.once('error', reject); proxy!.listen(0, '127.0.0.1', resolve); });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No proxy port available.');
  endpoint = `http://127.0.0.1:${address.port}`;

});

test.beforeEach(async () => {
  const existing = await service!.keys('');
  await Promise.all(existing.map(key => service!.delete(key)));
  await service!.putAll(initialObjects);
  directory = await mkdtemp(join(tmpdir(), 's3-client-transfer-desktop-'));
  profile = join(directory, 'profile');
  await mkdir(profile, { recursive: true });
  errors = [];
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined); app = undefined;
  throttleLargeDownloads = false;
  ignoredDeleteKey = undefined;
  formEncodedListings = false;
  throttleHistoryUploads = false;
  if (directory) await rm(directory, { recursive: true, force: true });
  expect(errors).toEqual([]);
});

test.afterAll(async () => {
  proxy?.closeAllConnections();
  await new Promise<void>(resolve => { if (proxy?.listening) proxy.close(() => resolve()); else resolve(); });
  await service?.close();
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

async function launch(packaged = false): Promise<Page> {
  app = await _electron.launch({
    ...(packaged ? { executablePath: packagedExecutable } : {}),
    args: [...(packaged ? [] : [root]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...isolatedEnvironment(), S3_CLIENT_DATA_DIR: profile, S3_CLIENT_E2E_HIDDEN: showTestWindow ? '0' : '1' }, timeout: 30_000,
  });
  const page = await app.firstWindow();
  if (!showTestWindow) expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  await app.evaluate(({ app }, home) => { app.setPath('home', home); }, directory);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function connect(page: Page, prefix = 'workspace/', permissions?: ConnectionPermissions): Promise<void> {
  const saved = await page.evaluate(async ({ endpoint, bucket, prefix, permissions }) => window.s3.saveConnection({
    name: 'Transfer S3', endpoint, bucket, prefix, region: 'us-east-1',
    accessKey: 'transfer-test-access', secretKey: 'transfer-test-secret',
    extraConfig: { s3: { addressing_style: 'path' }, read_timeout: 15 },
    permissions,
  }), { endpoint, bucket, prefix, permissions });
  expect(saved.permissions).toEqual(permissions ?? { download: true, upload: false, delete: false });
  await page.reload();
  await page.getByRole('button', { name: 'List folder' }).click();
  await expect(page.getByRole('table', { name: 'Folder contents' })).toBeVisible();
}

async function choose(paths: string[]): Promise<void> {
  await app!.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, paths);
}

async function chooseUpload(page: Page, paths: string[]): Promise<void> {
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Upload', exact: true });
  await chooser.getByLabel('Local folder', { exact: true }).fill(dirname(paths[0]));
  await chooser.getByRole('button', { name: 'Go', exact: true }).click();
  for (const path of paths) await chooser.getByRole('checkbox', { name: `Select ${basename(path)}`, exact: true }).check();
  await captureTestScreenshot(page, 'test-results/upload-chooser.png');
  await chooser.getByRole('button', { name: 'Upload', exact: true }).click();
}

const snapshot = (page: Page): Promise<TransferSnapshot> => page.evaluate(() => window.s3.transfers());
const task = (page: Page, name: string) => page.getByRole('article', { name, exact: true }).filter({ has: page.getByRole('progressbar') });
const panel = (page: Page, name: 'Downloads' | 'Uploads') => page.getByRole('dialog', { name, exact: true });
async function closePanel(page: Page): Promise<void> { await page.getByRole('button', { name: 'Close transfer panel' }).click(); }
async function openPanel(page: Page, direction: 'Downloads' | 'Uploads'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${direction}( \\([0-9]+ ongoing\\))?$`) }).click();
}
async function state(page: Page, name: string, status: string): Promise<void> {
  await expect(task(page, name).locator('.transfer-status')).toHaveText(status);
}

for (const packaged of [false, true]) test(`download task explains when its S3 object was deleted (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Build the packaged application first.');
  const name = `deleted-before-start-${packaged ? 'packaged' : 'source'}.txt`;
  const key = `workspace/${name}`;
  await service!.put(key, 'temporary');
  const page = await launch(packaged);
  await connect(page);
  const downloads = join(directory, 'downloads');
  await mkdir(downloads);
  await choose([downloads]);
  await openPanel(page, 'Downloads');
  await panel(page, 'Downloads').getByRole('button', { name: 'Stop all', exact: true }).click();
  await closePanel(page);
  await page.getByRole('table', { name: 'Folder contents' }).getByRole('button', { name: `Download ${name}` }).click();
  await state(page, name, 'Stopped');
  await service!.delete(key);
  await panel(page, 'Downloads').getByRole('button', { name: 'Start all', exact: true }).click();
  await state(page, name, 'Failed');
  await expect(task(page, name).locator('.transfer-error')).toContainText('no longer exists');
  expect(existsSync(join(downloads, name))).toBe(false);
});

test('real desktop permissions, lazy folders, uploads, deletion and idle history restoration', async () => {
  let page = await launch();
  await connect(page);
  const table = () => page.getByRole('table', { name: 'Folder contents' });
  await expect(table().locator('tbody tr')).toHaveCount(5);
  await expect(table().getByRole('button', { name: /^Download / })).toHaveCount(5);
  await expect(table().getByRole('button', { name: /^Delete / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toHaveCount(0);

  const downloads = join(directory, 'downloads');
  await mkdir(downloads);
  await choose([downloads]);
  await table().getByRole('button', { name: 'Download readme.bin', exact: true }).click();
  await state(page, 'readme.bin', 'Completed');
  expect(await readFile(join(downloads, 'readme.bin'))).toEqual(fileBytes);
  const completed = (await snapshot(page)).tasks.find(item => item.relativePath === 'readme.bin')!;
  expect(completed.transferred).toBe(fileBytes.length);
  expect(completed.size).toBe(fileBytes.length);
  await expect(task(page, 'readme.bin').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  await closePanel(page);

  await page.getByRole('button', { name: 'Manage Transfer S3', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await page.getByLabel('Allow uploads').check();
  await page.getByLabel('Allow deletes').check();
  await page.getByRole('button', { name: 'Save connection' }).click();
  await page.getByRole('button', { name: 'Manage Transfer S3', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await expect(page.getByLabel('Allow downloads')).toBeChecked();
  await expect(page.getByLabel('Allow uploads')).toBeChecked();
  await expect(page.getByLabel('Allow deletes')).toBeChecked();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(table().getByRole('button', { name: /^Delete / })).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Upload', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
  await page.getByRole('dialog', { name: 'Upload', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await snapshot(page)).tasks.filter(item => item.direction === 'upload')).toEqual([]);
  await captureTestScreenshot(page, 'test-results/transfers-browser.png');

  // Stop before opening the chooser: manifest discovery may allocate only its root.
  await openPanel(page, 'Downloads');
  await expect(page.getByLabel('Concurrent downloads')).toHaveValue('1');
  await page.getByRole('button', { name: 'Stop all', exact: true }).click();
  await closePanel(page);
  await table().getByRole('button', { name: 'Download collection', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tasks.filter(item => item.key.startsWith('workspace/collection/')).map(item => item.status)).toEqual(['paused', 'paused', 'paused']);
  expect((await stat(join(downloads, 'collection'))).isDirectory()).toBe(true);
  expect(await readdir(join(downloads, 'collection'))).toEqual([]);
  await task(page, 'collection/dfile').getByRole('button', { name: 'Start collection/dfile', exact: true }).click();
  await state(page, 'collection/dfile', 'Completed');
  expect(await readFile(join(downloads, 'collection/dfile'))).toEqual(topBytes);
  expect(existsSync(join(downloads, 'collection/bdir'))).toBe(false);
  expect(existsSync(join(downloads, 'collection/empty-leaf'))).toBe(false);
  await state(page, 'collection/bdir/cfile', 'Stopped');
  await captureTestScreenshot(page, 'test-results/transfers.png');
  await panel(page, 'Downloads').getByRole('button', { name: 'Start all', exact: true }).click();
  await state(page, 'collection/bdir/cfile', 'Completed');
  await state(page, 'collection/empty-leaf/', 'Completed');
  expect(await readFile(join(downloads, 'collection/bdir/cfile'))).toEqual(deepBytes);
  expect((await stat(join(downloads, 'collection/empty-leaf'))).isDirectory()).toBe(true);

  // Keep two real unfinished tasks for cancellation and the restart check.
  await page.getByRole('button', { name: 'Stop all', exact: true }).click();
  await closePanel(page);
  await table().getByRole('button', { name: 'Download restart.txt', exact: true }).click();
  await state(page, 'restart.txt', 'Stopped');
  await closePanel(page);
  await table().getByRole('button', { name: 'Download trash.txt', exact: true }).click();
  await state(page, 'trash.txt', 'Stopped');
  await task(page, 'trash.txt').getByRole('button', { name: 'Cancel trash.txt', exact: true }).click();
  await state(page, 'trash.txt', 'Cancelled');
  expect(existsSync(join(downloads, 'trash.txt'))).toBe(false);
  await closePanel(page);

  const uploadRoot = join(directory, 'local-upload');
  await mkdir(join(uploadRoot, 'bdir'), { recursive: true });
  await mkdir(join(uploadRoot, 'empty-leaf'));
  await writeFile(join(uploadRoot, 'dfile'), topBytes);
  await writeFile(join(uploadRoot, 'bdir/cfile'), deepBytes);
  const uploadOne = join(directory, 'uploaded-one.bin');
  const uploadTwo = join(directory, 'uploaded-two.txt');
  await writeFile(uploadOne, fileBytes);
  await writeFile(uploadTwo, 'second selected upload');
  await openPanel(page, 'Uploads');
  await expect(page.getByLabel('Concurrent uploads')).toHaveValue('1');
  await page.getByRole('button', { name: 'Stop all', exact: true }).click();
  await closePanel(page);
  await chooseUpload(page, [uploadOne, uploadTwo, uploadRoot]);
  await expect.poll(async () => (await snapshot(page)).tasks.filter(item => item.direction === 'upload').map(item => item.status)).toEqual(['paused', 'paused', 'paused', 'paused', 'paused']);
  expect(await remoteKeys('workspace/local-upload/')).toEqual([]);
  await page.getByRole('button', { name: 'Start all', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tasks.filter(item => item.direction === 'upload').map(item => item.status)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed']);
  expect(await remoteBytes('workspace/uploaded-one.bin')).toEqual(fileBytes);
  expect(await remoteBytes('workspace/uploaded-two.txt')).toEqual(Buffer.from('second selected upload'));
  expect(await remoteKeys('workspace/local-upload/')).toEqual(['workspace/local-upload/bdir/cfile', 'workspace/local-upload/dfile', 'workspace/local-upload/empty-leaf/']);
  expect(await remoteBytes('workspace/local-upload/dfile')).toEqual(topBytes);
  expect(await remoteBytes('workspace/local-upload/bdir/cfile')).toEqual(deepBytes);
  await closePanel(page);
  await expect(table().getByText('local-upload', { exact: true })).toBeVisible();
  await expect(table().getByText('uploaded-one.bin', { exact: true })).toBeVisible();

  for (const name of ['trash.txt', 'collection']) {
    const prefix = name === 'collection' ? 'workspace/collection/' : 'workspace/trash.txt';
    const before = await remoteKeys(prefix);
    await table().getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    const kind = name === 'collection' ? 'folder' : 'file';
    const confirmation = page.getByRole('alertdialog', { name: `Delete ${kind}?` });
    await expect(confirmation.getByText(`s3://${bucket}/${prefix}`, { exact: true })).toBeVisible();
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    expect(await remoteKeys(prefix)).toEqual(before);
    await captureTestScreenshot(page, `test-results/delete-${kind}.png`);
    await page.keyboard.press(kind === 'file' ? 'Enter' : 'Escape');
    await expect(confirmation).toHaveCount(0);
    await expect(table().getByRole('button', { name: `Delete ${name}`, exact: true })).toBeEnabled();
    expect(await remoteKeys(prefix)).toEqual(before);
    await table().getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    await confirmation.getByRole('button', { name: `Delete ${kind}`, exact: true }).click();
    await expect(table().getByText(name, { exact: true })).toHaveCount(0);
    expect(await remoteKeys(prefix)).toEqual([]);
  }
  expect(await remoteBytes('workspace/collection-neighbor/keep.txt')).toEqual(Buffer.from('neighbor survives'));
  expect(await remoteBytes('workspace/readme.bin')).toEqual(fileBytes);
  expect(await readFile(join(downloads, 'collection/dfile'))).toEqual(topBytes);

  await app!.close(); app = undefined;
  const requestsBeforeRestart = requests;
  page = await launch();
  await expect(table().getByText('readme.bin', { exact: true })).toBeVisible();
  await openPanel(page, 'Downloads');
  await state(page, 'restart.txt', 'Stopped');
  expect((await snapshot(page)).paused.download).toBe(true);
  expect(await app!.evaluate(() => process.getActiveResourcesInfo().includes('ProcessWrap'))).toBe(false);
  expect(requests).toBe(requestsBeforeRestart);
  expect(existsSync(join(downloads, 'restart.txt'))).toBe(false);
  await task(page, 'restart.txt').getByRole('button', { name: 'Cancel restart.txt', exact: true }).click();
  await state(page, 'restart.txt', 'Cancelled');
  const history = await readFile(join(profile, 'transfer-queue.json'), 'utf8');
  expect(history).not.toContain('transfer-test-access');
  expect(history).not.toContain('transfer-test-secret');
});

for (const packaged of [false, true]) test(`bulk downloads and deletes a checked file and folder with one prompt (${packaged ? 'packaged' : 'source'})`, async () => {
  const page = await launch(packaged);
  await connect(page, 'workspace/', { download: true, upload: false, delete: true });
  const table = page.getByRole('table', { name: 'Folder contents' });
  await expect(table.locator('tbody tr')).toHaveCount(5);
  const collectionBox = table.locator('input[aria-label="Select collection"]');
  const readmeBox = table.locator('input[aria-label="Select readme.bin"]');
  const select = async () => {
    await collectionBox.check();
    await readmeBox.check();
  };
  await select();
  const downloads = join(directory, 'bulk-downloads'); await mkdir(downloads);
  await app!.evaluate(({ dialog }, filePaths) => {
    const counted = dialog as typeof dialog & { pickerCalls: number };
    counted.pickerCalls = 0;
    dialog.showOpenDialog = async () => { counted.pickerCalls++; return { canceled: false, filePaths }; };
  }, [downloads]);
  await page.getByRole('button', { name: 'Download 2 selected' }).click();
  await expect(panel(page, 'Downloads')).toBeVisible();
  expect(await app!.evaluate(({ dialog }) => (dialog as typeof dialog & { pickerCalls: number }).pickerCalls)).toBe(1);
  await expect.poll(() => ['collection/dfile', 'collection/bdir/cfile', 'readme.bin'].every(path => existsSync(join(downloads, path))), { timeout: 30_000 }).toBe(true);
  expect(await readFile(join(downloads, 'collection', 'dfile'))).toEqual(topBytes);
  expect(await readFile(join(downloads, 'collection', 'bdir', 'cfile'))).toEqual(deepBytes);
  expect(await readFile(join(downloads, 'readme.bin'))).toEqual(fileBytes);
  await closePanel(page);

  await select();
  await page.getByRole('button', { name: 'Delete 2 selected' }).click();
  let confirmation = page.getByRole('alertdialog', { name: 'Delete selected items?' });
  await expect(confirmation).toContainText('contents of selected folders');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await remoteKeys('workspace/collection/')).toContain('workspace/collection/dfile');
  await expect(collectionBox).toBeChecked();
  await page.getByRole('button', { name: 'Delete 2 selected' }).click();
  confirmation = page.getByRole('alertdialog', { name: 'Delete selected items?' });
  await confirmation.getByRole('button', { name: 'Delete 2 items' }).click();
  await expect(collectionBox).toHaveCount(0);
  await expect(readmeBox).toHaveCount(0);
  expect(await remoteKeys('workspace/collection/')).toEqual([]);
  expect(await remoteKeys('workspace/readme.bin')).toEqual([]);
  expect(await remoteKeys('workspace/collection-neighbor/')).toEqual(['workspace/collection-neighbor/keep.txt']);
});

test('active byte progress, individual stop/resume/cancel and cancel all clean partials', async () => {
  throttleLargeDownloads = true;
  const page = await launch();
  await connect(page, 'active/');
  const downloads = join(directory, 'downloads');
  await mkdir(downloads);
  await choose([downloads]);
  const table = page.getByRole('table', { name: 'Folder contents' });
  await table.getByRole('button', { name: 'Download keep.txt', exact: true }).click();
  await state(page, 'keep.txt', 'Completed');
  await closePanel(page);
  await table.getByRole('button', { name: 'Download large.bin', exact: true }).click();
  const progressing = async () => {
    const current = (await snapshot(page)).tasks.find(item => item.relativePath === 'large.bin');
    return current?.status === 'running' && current.transferred > 0 && current.transferred < current.size;
  };
  await expect.poll(progressing, { timeout: 30_000 }).toBe(true);
  const beforeStop = (await snapshot(page)).tasks.find(item => item.relativePath === 'large.bin')!;
  expect(beforeStop.size).toBe(16 * 1024 * 1024);
  expect(beforeStop.bytesPerSecond).toBeGreaterThan(0);
  await expect(task(page, 'large.bin').locator('.transfer-speed')).toHaveText(/^[1-9][\d.]*(?:B|kB|MB|GB)\/s$/);
  await captureTestScreenshot(page, 'test-results/transfer-speed.png');
  expect((await readdir(downloads)).some(name => name.startsWith('.s3client-') && name.endsWith('.part'))).toBe(true);
  await task(page, 'large.bin').getByRole('button', { name: 'Stop large.bin', exact: true }).click();
  await state(page, 'large.bin', 'Stopped');
  await expect(task(page, 'large.bin').locator('.transfer-speed')).toHaveCount(0);
  await expect.poll(() => readdir(downloads)).toEqual(['keep.txt']);
  await task(page, 'large.bin').getByRole('button', { name: 'Start large.bin', exact: true }).click();
  await expect.poll(progressing, { timeout: 30_000 }).toBe(true);
  await task(page, 'large.bin').getByRole('button', { name: 'Cancel large.bin', exact: true }).click();
  await state(page, 'large.bin', 'Cancelled');
  await expect.poll(() => readdir(downloads)).toEqual(['keep.txt']);
  expect(await readFile(join(downloads, 'keep.txt'))).toEqual(Buffer.from('completed files survive cancellation'));
  await page.getByRole('button', { name: 'Stop all', exact: true }).click();
  for (const name of ['queued-one.txt', 'queued-two.txt']) {
    await closePanel(page);
    await table.getByRole('button', { name: `Download ${name}`, exact: true }).click();
    await state(page, name, 'Stopped');
  }
  await page.getByRole('button', { name: 'Cancel all', exact: true }).click();
  await state(page, 'queued-one.txt', 'Cancelled');
  await state(page, 'queued-two.txt', 'Cancelled');
  await state(page, 'keep.txt', 'Completed');
  expect(await readdir(downloads)).toEqual(['keep.txt']);
});

test('packaged desktop runs transfers and styled file/folder delete confirmations', async () => {
  expect(existsSync(packagedExecutable), 'Run npm run pack before the mandatory packaged transfer smoke test.').toBe(true);
  const page = await launch(true);
  expect(await app!.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await connect(page);
  const downloads = join(directory, 'downloads');
  await mkdir(downloads);
  await choose([downloads]);
  await page.getByRole('table').getByRole('button', { name: 'Download readme.bin', exact: true }).click();
  await state(page, 'readme.bin', 'Completed');
  expect(await readFile(join(downloads, 'readme.bin'))).toEqual(fileBytes);
  const done = (await snapshot(page)).tasks.find(item => item.relativePath === 'readme.bin')!;
  expect(done.transferred).toBe(fileBytes.length);
  expect(done.size).toBe(fileBytes.length);
  await captureTestScreenshot(page, 'test-results/packaged-transfers.png');
  await closePanel(page);
  await service!.putAll([
    ['workspace/packaged-delete.txt', 'delete file'],
    ['workspace/packaged-trash/', ''],
    ['workspace/packaged-trash/nested/file.txt', 'delete nested file'],
    ['workspace/packaged-trash-neighbor/keep.txt', 'keep neighbor'],
  ]);
  await page.getByRole('button', { name: 'Manage Transfer S3', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await page.getByLabel('Allow deletes').check();
  await page.getByRole('button', { name: 'Save connection' }).click();
  const table = page.getByRole('table');
  for (const [name, kind, prefix] of [
    ['packaged-delete.txt', 'file', 'workspace/packaged-delete.txt'],
    ['packaged-trash', 'folder', 'workspace/packaged-trash/'],
  ]) {
    const before = await remoteKeys(prefix);
    expect(before.length).toBeGreaterThan(0);
    await table.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    const confirmation = page.getByRole('alertdialog', { name: `Delete ${kind}?` });
    await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await expect(confirmation.getByText(`s3://${bucket}/${prefix}`, { exact: true })).toBeVisible();
    expect(await remoteKeys(prefix)).toEqual(before);
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(table.getByRole('button', { name: `Delete ${name}`, exact: true })).toBeEnabled();
    expect(await remoteKeys(prefix)).toEqual(before);
    await table.getByRole('button', { name: `Delete ${name}`, exact: true }).click();
    await captureTestScreenshot(page, `test-results/packaged-delete-${kind}.png`);
    await confirmation.getByRole('button', { name: `Delete ${kind}`, exact: true }).click();
    await expect(table.getByText(name, { exact: true })).toHaveCount(0);
    expect(await remoteKeys(prefix)).toEqual([]);
  }
  expect(await remoteBytes('workspace/packaged-trash-neighbor/keep.txt')).toEqual(Buffer.from('keep neighbor'));
});

for (const packaged of [false, true]) test(`uploads a 100 MiB file through multipart S3 with exact contents (${packaged ? 'packaged' : 'source'})`, async () => {
  const source = join(directory, 'multipart-100MiB.bin');
  const block = Buffer.alloc(1024 * 1024, packaged ? 0x5b : 0x5a);
  const hash = createHash('sha256');
  const file = await open(source, 'wx');
  try { for (let index = 0; index < 100; index++) { await file.write(block); hash.update(block); } }
  finally { await file.close(); }
  const expectedHash = hash.digest('hex');
  const page = await launch(packaged);
  await connect(page);
  await page.getByRole('button', { name: 'Manage Transfer S3', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await page.getByLabel('Allow uploads').check();
  await page.getByRole('button', { name: 'Save connection' }).click();
  await chooseUpload(page, [source]);
  await expect.poll(async () => {
    const current = (await snapshot(page)).tasks.find(item => item.relativePath === 'multipart-100MiB.bin');
    if (current?.status === 'failed') throw new Error(current.error);
    return current?.status;
  }, { timeout: 60_000 }).toBe('completed');
  const result = await service!.digest('workspace/multipart-100MiB.bin');
  expect(result).toEqual({ size: 100 * 1024 * 1024, sha256: expectedHash });
});

for (const packaged of [false, true]) for (const formEncoded of [false, true]) test(`verifies deletion of a 22.5 MiB multipart file with ${formEncoded ? 'spaces and parentheses using form-encoded listings' : '+ in its name'} (${packaged ? 'packaged' : 'source'})`, async () => {
  formEncodedListings = formEncoded;
  const name = formEncoded ? '20261001T000010_pdb-l4e-LJ18R2BL5S3302862_36_0to5 (6).db' : `delete-${packaged ? 'packaged' : 'source'}+08:00-22.5MiB.bin`;
  const key = `workspace/${name}`;
  const source = join(directory, name);
  const block = Buffer.alloc(1024 * 1024, 0x5c);
  const local = await open(source, 'wx');
  try {
    for (let index = 0; index < 22; index++) await local.write(block);
    await local.write(block.subarray(0, 512 * 1024));
  } finally { await local.close(); }
  const page = await launch(packaged);
  await connect(page);
  await page.getByRole('button', { name: 'Manage Transfer S3', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await page.getByLabel('Allow uploads').check();
  await page.getByLabel('Allow deletes').check();
  await page.getByRole('button', { name: 'Save connection' }).click();
  await chooseUpload(page, [source]);
  await expect(task(page, name).locator('.transfer-status')).toHaveText('Completed', { timeout: 60_000 });
  expect((await snapshot(page)).tasks.find(item => item.relativePath === name)?.size).toBe(23592960);
  await closePanel(page);
  await expect(page.getByRole('table', { name: 'Folder contents' }).getByText(name, { exact: true })).toBeVisible();
  if (formEncoded) await expect(page.getByRole('table').getByText(name.replace(' (6)', '+(6)'), { exact: true })).toHaveCount(0);
  expect(await service!.size(key)).toBe(23592960);
  await service!.put(`${key}.backup`, 'keep neighbor');

  const table = page.getByRole('table', { name: 'Folder contents' });
  const remove = table.getByRole('button', { name: `Delete ${name}`, exact: true });
  ignoredDeleteKey = key; // Simulate HTTP success with no actual server-side deletion.
  await remove.click();
  await page.getByRole('alertdialog', { name: 'Delete file?' }).getByRole('button', { name: 'Delete file', exact: true }).click();
  await expect(page.getByText('The delete request completed, but the item is still listed by the storage service. Refresh the folder before retrying.', { exact: true })).toBeVisible();
  await expect(remove).toBeEnabled();
  await expect(page.getByText(`${name} deleted`, { exact: true })).toHaveCount(0);
  expect(await remoteKeys(key)).toEqual([key, `${key}.backup`]);

  ignoredDeleteKey = undefined;
  await remove.click();
  const confirmation = page.getByRole('alertdialog', { name: 'Delete file?' });
  await expect(confirmation.getByText(`s3://${bucket}/${key}`, { exact: true })).toBeVisible();
  await confirmation.getByRole('button', { name: 'Delete file', exact: true }).click();
  await expect(remove).toHaveCount(0);
  await expect(page.getByText(`${name} deleted`, { exact: true })).toBeVisible();
  expect(await remoteKeys(key)).toEqual([`${key}.backup`]);
  expect(await remoteBytes(`${key}.backup`)).toEqual(Buffer.from('keep neighbor'));
});

for (const packaged of [false, true]) test(`removes transfer rows and clears lists while preserving data and restart state (${packaged ? 'packaged' : 'source'})`, async () => {
  throttleLargeDownloads = true;
  let page = await launch(packaged);
  await connect(page, 'active/');
  const downloads = join(directory, 'history-downloads');
  await mkdir(downloads); await choose([downloads]);
  const table = () => page.getByRole('table', { name: 'Folder contents' });
  await table().getByRole('button', { name: 'Download keep.txt', exact: true }).click();
  await state(page, 'keep.txt', 'Completed'); await closePanel(page);

  await page.getByRole('button', { name: 'Manage Transfer S3', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await page.getByLabel('Allow uploads').check();
  await page.getByRole('button', { name: 'Save connection' }).click();
  const historyName = `history-${packaged ? 'packaged' : 'source'}.txt`;
  const source = join(directory, historyName);
  await writeFile(source, 'completed upload is kept');
  await chooseUpload(page, [source]); await state(page, historyName, 'Completed'); await closePanel(page);

  await table().getByRole('button', { name: 'Download large.bin', exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).tasks.some(item => item.relativePath === 'large.bin' && item.status === 'running' && item.transferred > 0)).toBe(true);
  await task(page, 'large.bin').getByRole('button', { name: 'Remove large.bin from list', exact: true }).click();
  let confirmation = page.getByRole('alertdialog', { name: 'Remove transfer?' });
  await expect(confirmation).toContainText('Completed files and S3 objects will be kept.');
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(task(page, 'large.bin').getByRole('button', { name: 'Remove large.bin from list', exact: true })).toBeEnabled();
  await task(page, 'large.bin').getByRole('button', { name: 'Remove large.bin from list', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Remove row', exact: true }).click();
  await expect(task(page, 'large.bin')).toHaveCount(0);
  expect(await readdir(downloads)).toEqual(['keep.txt']);
  expect(await service!.size('active/large.bin')).toBe(16 * 1024 * 1024);

  await task(page, 'keep.txt').getByRole('button', { name: 'Remove keep.txt from list', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Remove row', exact: true }).click();
  await expect(task(page, 'keep.txt')).toHaveCount(0);
  expect(await readFile(join(downloads, 'keep.txt'), 'utf8')).toBe('completed files survive cancellation');
  await panel(page, 'Downloads').getByRole('button', { name: 'Stop all', exact: true }).click(); await closePanel(page);
  for (const name of ['queued-one.txt', 'queued-two.txt']) {
    await table().getByRole('button', { name: `Download ${name}`, exact: true }).click();
    await state(page, name, 'Stopped'); await closePanel(page);
  }
  await openPanel(page, 'Downloads');
  await panel(page, 'Downloads').getByRole('button', { name: 'Clear all', exact: true }).click();
  confirmation = page.getByRole('alertdialog', { name: 'Clear downloads?' });
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel(page, 'Downloads').getByRole('article')).toHaveCount(2);
  await panel(page, 'Downloads').getByRole('button', { name: 'Clear all', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Keep tasks and clear finished', exact: true }).click();
  await expect(panel(page, 'Downloads').getByRole('article')).toHaveCount(2);
  expect((await snapshot(page)).tasks.filter(item => item.direction === 'download').map(item => item.status)).toEqual(['paused', 'paused']);
  await panel(page, 'Downloads').getByRole('button', { name: 'Clear all', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Cancel tasks and clear all', exact: true }).click();
  await expect(panel(page, 'Downloads').getByRole('article')).toHaveCount(0);
  expect((await snapshot(page)).tasks.map(item => item.relativePath)).toEqual([historyName]);
  await closePanel(page);

  const largeName = `row-removal-${packaged ? 'packaged' : 'source'}.bin`;
  const large = join(directory, largeName); const waiting = join(directory, 'waiting.txt');
  await writeFile(large, Buffer.alloc(24 * 1024 * 1024, 0x5d)); await writeFile(waiting, 'waiting upload');
  await openPanel(page, 'Uploads');
  await panel(page, 'Uploads').getByRole('button', { name: 'Stop all', exact: true }).click(); await closePanel(page);
  const requestsBefore = historyUploadRequests;
  throttleHistoryUploads = true;
  await chooseUpload(page, [large, waiting]);
  await state(page, largeName, 'Stopped');
  await task(page, largeName).getByRole('button', { name: `Start ${largeName}`, exact: true }).click();
  await expect.poll(() => historyUploadRequests).toBeGreaterThan(requestsBefore);
  await state(page, largeName, 'Transferring');
  await panel(page, 'Uploads').getByRole('button', { name: 'Clear all', exact: true }).click();
  confirmation = page.getByRole('alertdialog', { name: 'Clear uploads?' });
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await captureTestScreenshot(page, 'test-results/clear-transfers-confirmation.png');
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel(page, 'Uploads').getByRole('article')).toHaveCount(3);
  await captureTestScreenshot(page, 'test-results/transfer-row-controls.png');
  await panel(page, 'Uploads').getByRole('button', { name: 'Clear all', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Keep tasks and clear finished', exact: true }).click();
  await expect(panel(page, 'Uploads').getByRole('article')).toHaveCount(2);
  await state(page, largeName, 'Transferring');
  expect((await snapshot(page)).tasks.filter(item => item.direction === 'upload').map(item => item.status)).toEqual(['running', 'paused']);
  await panel(page, 'Uploads').getByRole('button', { name: 'Clear all', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Cancel tasks and clear all', exact: true }).click();
  await expect(panel(page, 'Uploads').getByRole('article')).toHaveCount(0);
  expect((await snapshot(page)).tasks).toEqual([]);
  expect(await remoteBytes(`active/${historyName}`)).toEqual(Buffer.from('completed upload is kept'));
  expect(await remoteKeys(`active/${largeName}`)).toEqual([]);
  expect((await stat(large)).size).toBe(24 * 1024 * 1024);
  expect(await readFile(source, 'utf8')).toBe('completed upload is kept');
  expect(await readFile(join(downloads, 'keep.txt'), 'utf8')).toBe('completed files survive cancellation');
  await app!.close(); app = undefined;
  const requestsBeforeRestart = requests;
  page = await launch(packaged);
  await expect(table()).toBeVisible();
  for (const title of ['Downloads', 'Uploads'] as const) {
    await openPanel(page, title);
    await expect(panel(page, title).getByRole('article')).toHaveCount(0);
    await expect(panel(page, title).getByRole('button', { name: 'Clear all', exact: true })).toBeDisabled();
    await closePanel(page);
  }
  expect(requests).toBe(requestsBeforeRestart);
  expect(JSON.parse(await readFile(join(profile, 'transfer-queue.json'), 'utf8')).tasks).toEqual([]);
});
