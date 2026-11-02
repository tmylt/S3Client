import { test, expect, _electron, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { captureTestScreenshot, showTestWindow } from './desktop-test-window';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalS3, adaptCopySourceForFixture, encodeListingXML, fixZeroRangeForFixture } from './s3-test-server';

const root = process.cwd();
let server: LocalS3;
let proxy: Server;
let endpoint: string;
let directory: string;
let app: ElectronApplication | undefined;
const errors: string[] = [];
const extraConfig = { s3: { addressing_style: 'path' }, read_timeout: 15 };
const documentBytes = Buffer.byteLength('# Hello from S3\n') + Buffer.byteLength('Only visible inside nested.');
let listingRequests = 0;
const packagedExecutable = process.platform === 'linux' ? join(root, 'release/linux-unpacked/s3-client') : process.platform === 'win32' ? join(root, 'release/win-unpacked/S3 Client.exe') : join(root, `release/${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/S3 Client.app/Contents/MacOS/S3 Client`);

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 's3-client-desktop-'));
  server = await LocalS3.start('desktop-fixtures');
  proxy = createServer((incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', server.endpoint);
    if (url.searchParams.get('list-type') === '2') listingRequests++;
    const { authorization: _authorization, ...headers } = incoming.headers;
    if (typeof headers['x-amz-copy-source'] === 'string') headers['x-amz-copy-source'] = adaptCopySourceForFixture(headers['x-amz-copy-source']);
    const upstream = request(url, { method: incoming.method, headers: { ...headers, host: new URL(server.endpoint).host } }, response => {
      if (incoming.headers.range === 'bytes=0-0' && response.statusCode === 206) {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const fixed = fixZeroRangeForFixture(response.headers, Buffer.concat(chunks));
          outgoing.writeHead(206, fixed.headers); outgoing.end(fixed.body);
        });
      } else if (url.searchParams.get('list-type') === '2' && url.searchParams.get('encoding-type') === 'url' && response.statusCode === 200) {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const body = encodeListingXML(Buffer.concat(chunks).toString('utf8'));
          const { 'transfer-encoding': _encoding, 'content-length': _length, ...forwarded } = response.headers;
          outgoing.writeHead(200, { ...forwarded, 'content-length': String(body.length) });
          outgoing.end(body);
        });
      } else { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); }
    });
    upstream.on('error', () => outgoing.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No test port available.');
  endpoint = `http://127.0.0.1:${address.port}`;
  await server.putAll([
    ['workspace/', ''],
    ['workspace/documents/readme.md', '# Hello from S3\n'],
    ['workspace/documents/nested/deep.txt', 'Only visible inside nested.'],
    ['workspace/photos/summer.jpg', 'fixture'],
    ['workspace/empty/', ''],
    ['workspace/100% + #.txt', 'Preserve the exact key.'],
    ['workspace/notes.txt', 'A desktop app backed by TypeScript.'],
    ['outside-root.txt', 'Must never appear within workspace.'],
    ...Array.from({ length: 1005 }, (_, index) => [`workspace/paged/item${index}.txt`, 'pagination'] as const),
  ]);
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  proxy?.closeAllConnections();
  if (proxy?.listening) await new Promise<void>(resolve => proxy.close(() => resolve()));
  await server?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function launch(packaged = false, dataDirectory = directory): Promise<Page> {
  app = await _electron.launch({
    ...(packaged ? { executablePath: packagedExecutable } : {}),
    args: [...(packaged ? [] : [root]), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    env: { ...process.env, S3_CLIENT_DATA_DIR: dataDirectory, S3_CLIENT_E2E_HIDDEN: showTestWindow ? '0' : '1' },
    timeout: 30_000,
  });
  await app.evaluate(({ app }) => app.whenReady());
  const page = await app.firstWindow();
  if (!showTestWindow) expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible()))).toBe(true);
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function checkSavedSecret(dialog: Locator): Promise<void> {
  const secret = dialog.getByLabel('Secret key (SK)');
  await expect(secret).toHaveValue('test-secret');
  await expect(secret).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Show secret key' }).click();
  await expect(secret).toHaveAttribute('type', 'text');
  await expect(secret).toHaveValue('test-secret');
  await dialog.getByRole('button', { name: 'Hide secret key' }).click();
  await expect(secret).toHaveAttribute('type', 'password');
}

async function checkFolderStats(page: Page, name: string, count: number, bytes: number): Promise<string> {
  const button = page.getByRole('button', { name: `Refresh statistics for ${name}`, exact: true });
  const row = page.getByRole('table').locator('tbody tr').filter({ has: button });
  await button.click();
  await expect(button).toBeEnabled();
  await expect(row.locator('td').nth(4)).toHaveText(count.toLocaleString());
  await expect(row.locator('td').nth(3)).toHaveAttribute('title', `${bytes.toLocaleString()} bytes`);
  const stamp = await row.locator('time').getAttribute('datetime');
  expect(Number.isFinite(Date.parse(stamp!))).toBe(true);
  await expect(row.locator('.stats-updated small')).toContainText('in ');
  return stamp!;
}

async function checkColumnResizing(page: Page): Promise<{ name: string; modified: string }> {
  const table = page.getByRole('table', { name: 'Folder contents' });
  const name = table.getByRole('separator', { name: 'Resize Name column' });
  const modified = table.getByRole('separator', { name: 'Resize Date modified column' });
  await expect(table.getByRole('separator')).toHaveCount(7);
  await name.dblclick(); await modified.dblclick();
  await page.locator('.file-table-scroll').evaluate(element => { element.scrollLeft = 0; });
  const widths = () => table.locator('thead th').evaluateAll(headers => headers.slice(1, 8).map(header => header.getBoundingClientRect().width));
  const before = await widths();
  const requestCount = listingRequests;
  const box = await name.boundingBox();
  if (!box) throw new Error('Missing Name resize handle.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 173, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(name).toHaveAttribute('aria-valuenow', '413');
  const after = await widths();
  expect(after[0] - before[0]).toBeCloseTo(173, 0);
  for (let index = 1; index < before.length; index++) expect(after[index]).toBeCloseTo(before[index], 0);
  expect(await table.locator('tbody tr').first().locator('td').nth(1).evaluate(cell => cell.getBoundingClientRect().width)).toBeCloseTo(after[0], 0);
  await expect(table.getByRole('columnheader', { name: 'Name', exact: true })).toHaveAttribute('aria-sort', 'ascending');

  // Escape cancels an in-progress drag and releases the resize cursor.
  const next = await name.boundingBox();
  if (!next) throw new Error('Missing resized Name handle.');
  await page.mouse.move(next.x + next.width / 2, next.y + next.height / 2);
  await page.mouse.down();
  await page.mouse.move(next.x + next.width / 2 + 40, next.y + next.height / 2);
  await expect(name).toHaveAttribute('aria-valuenow', '453');
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(name).toHaveAttribute('aria-valuenow', '413');
  await expect(page.locator('html')).not.toHaveClass(/resizing-columns/);
  await modified.focus(); await page.keyboard.press('Shift+ArrowRight');
  await expect(modified).toHaveAttribute('aria-valuenow', '210');
  expect(await page.locator('.file-table-scroll').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(listingRequests).toBe(requestCount);
  await captureTestScreenshot(page, 'test-results/resizable-columns.png');
  return { name: '413', modified: '210' };
}

async function checkSavedColumnWidths(page: Page, widths: { name: string; modified: string }): Promise<void> {
  const table = page.getByRole('table', { name: 'Folder contents' });
  await expect(table.getByRole('separator', { name: 'Resize Name column' })).toHaveAttribute('aria-valuenow', widths.name);
  await expect(table.getByRole('separator', { name: 'Resize Date modified column' })).toHaveAttribute('aria-valuenow', widths.modified);
}

async function checkConnectionCopy(page: Page, sourceName: string, prefix: string): Promise<void> {
  await page.getByRole('button', { name: `Manage ${sourceName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Copy connection' }).click();
  const copiedName = `${sourceName} (copy)`;
  await expect(page.getByRole('button', { name: `Manage ${copiedName}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Manage ${sourceName}`, exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: `Manage ${copiedName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Connection name')).toHaveValue(copiedName);
  await expect(dialog.getByLabel('Endpoint URL')).toHaveValue(endpoint);
  await expect(dialog.getByLabel('Bucket', { exact: true })).toHaveValue('desktop-fixtures');
  await expect(dialog.getByLabel('Prefix', { exact: false })).toHaveValue(prefix);
  await expect(dialog.getByLabel('Region', { exact: false })).toHaveValue('');
  await expect(dialog.getByLabel('Access key (AK)')).toHaveValue('test-access');
  expect(JSON.parse(await dialog.getByLabel('Extra config (JSON)', { exact: false }).inputValue())).toEqual(extraConfig);
  await checkSavedSecret(dialog);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: `Manage ${copiedName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove connection' }).click();
  const confirmation = page.getByRole('alertdialog', { name: 'Remove connection?' });
  await expect(confirmation.getByText(copiedName, { exact: true })).toBeVisible();
  await expect(confirmation.getByText(`s3://desktop-fixtures/${prefix}`, { exact: true })).toBeVisible();
  await expect(confirmation.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await expect(confirmation).toContainText('Your files in S3 will be kept.');
  await expect(page.locator('.desktop-app')).toHaveAttribute('inert', '');
  await captureTestScreenshot(page, 'test-results/remove-connection.png');
  expect((await page.evaluate(() => window.s3.connections())).connections.some(connection => connection.name === copiedName)).toBe(true);
  await page.keyboard.press('Enter');
  await expect(confirmation).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Manage ${copiedName}`, exact: true })).toBeVisible();
  await expect(page.getByText('Connection removed', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: `Manage ${copiedName}`, exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove connection' }).click();
  await confirmation.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await expect(page.getByRole('button', { name: `Manage ${copiedName}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Manage ${sourceName}`, exact: true })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
}

test('browse, refresh, paginate, reconnect and remove through the real Electron/S3 stack', async () => {
  test.setTimeout(360_000);
  let page = await launch();
  await expect(page.getByRole('heading', { name: 'Your cloud. A little closer.' })).toBeVisible();
  await captureTestScreenshot(page, 'test-results/welcome.png');
  await page.getByRole('button', { name: 'Add your first connection' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Connection name').fill('Local S3');
  await dialog.getByLabel('Endpoint URL').fill(endpoint);
  await dialog.getByLabel('Bucket', { exact: true }).fill('desktop-fixtures');
  await dialog.getByLabel('Prefix', { exact: false }).fill('workspace/');
  await dialog.getByLabel('Extra config (JSON)', { exact: false }).fill(JSON.stringify(extraConfig));
  await dialog.getByLabel('Access key (AK)').fill('test-access');
  await dialog.getByLabel('Secret key (SK)').fill('test-secret');
  await dialog.getByLabel('Connection name').fill('Local S3');
  await dialog.getByLabel('Prefix', { exact: false }).fill('workspace/');
  await expect(dialog.getByLabel('Connection name')).toHaveValue('Local S3');
  await expect(dialog.getByLabel('Prefix', { exact: false })).toHaveValue('workspace/');
  await dialog.getByRole('button', { name: 'Connect & browse' }).click();
  const table = page.getByRole('table', { name: 'Folder contents' });
  await expect(table.getByRole('row')).toHaveCount(7); // header + four folders + two files
  await expect(table.getByText('outside-root.txt')).toHaveCount(0);
  await expect(table.getByText('readme.md')).toHaveCount(0);
  await expect(table.getByText('100% + #.txt', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Search range')).toHaveValue('folder');
  await expect(page.getByLabel('Name match')).toHaveValue('exact');
  const beforeExact = listingRequests;
  await page.getByLabel('Search file name').fill('notes.txt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('notes.txt', { exact: true })).toBeVisible();
  expect(listingRequests).toBe(beforeExact);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Search file name').fill('100% + #.txt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('100% + #.txt', { exact: true })).toBeVisible();
  expect(listingRequests).toBe(beforeExact);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Search file name').fill('missing-file.txt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  expect(listingRequests).toBe(beforeExact);
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Name match').selectOption('contains');
  await page.getByLabel('Search file name').fill('otes');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('notes.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Search range').selectOption('recursive');
  await page.getByLabel('Name match').selectOption('exact');
  await page.getByLabel('Search file name').fill('deep.txt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('documents/nested/deep.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Name match').selectOption('prefix');
  await page.getByLabel('Search file name').fill('deep');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('documents/nested/deep.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Search range').selectOption('folder');
  await page.getByLabel('Name match').selectOption('exact');
  const columnWidths = await checkColumnResizing(page);
  await captureTestScreenshot(page, 'test-results/browser.png');

  // Edit fields reflect stored settings; clearing region stays empty on later edits.
  await page.getByRole('button', { name: 'Manage Local S3' }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await expect(dialog.getByLabel('Region', { exact: false })).toHaveValue('us-east-1');
  expect(JSON.parse(await dialog.getByLabel('Extra config (JSON)', { exact: false }).inputValue())).toEqual(extraConfig);
  await expect(dialog.getByLabel('Access key (AK)')).toHaveValue('test-access');
  await checkSavedSecret(dialog);
  await dialog.getByLabel('Region', { exact: false }).fill('');
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(table).toBeVisible();
  await page.getByRole('button', { name: 'Manage Local S3' }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await expect(dialog.getByLabel('Region', { exact: false })).toHaveValue('');
  await expect(dialog.getByLabel('Access key (AK)')).toHaveValue('test-access');
  await expect(dialog.getByLabel('Secret key (SK)')).toHaveValue('test-secret');
  await expect(dialog.getByLabel('Secret key (SK)')).toHaveAttribute('type', 'password');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

  const documentsStatsAt = await checkFolderStats(page, 'documents', 2, documentBytes);
  await checkFolderStats(page, 'empty', 0, 0);
  await checkFolderStats(page, 'paged', 1005, 1005 * Buffer.byteLength('pagination'));
  await captureTestScreenshot(page, 'test-results/folder-stats.png');

  await checkConnectionCopy(page, 'Local S3', 'workspace/');

  await page.getByRole('button', { name: 'Expand documents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Collapse documents', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'nested', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse documents', exact: true }).click();
  await expect(page.getByRole('navigation').getByRole('button', { name: 'nested', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand documents', exact: true })).toBeVisible();

  await table.getByText('documents', { exact: true }).dblclick();
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  await expect(table.getByText('deep.txt')).toHaveCount(0);
  await table.getByText('nested', { exact: true }).dblclick();
  await expect(table.getByText('deep.txt', { exact: true })).toBeVisible();
  await page.getByLabel('Folder path').getByRole('button', { name: 'documents', exact: true }).click();
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(table.getByText('deep.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  await page.getByLabel('Search range').selectOption('page');
  await page.getByLabel('Name match').selectOption('contains');
  await page.getByLabel('Search file name').fill('no-match');
  await expect(page.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await table.getByText('readme.md', { exact: true }).click();
  await page.getByRole('button', { name: 'Toggle item information' }).click();
  await expect(page.getByRole('complementary', { name: 'Item information' }).getByText('workspace/documents/readme.md')).toBeVisible();
  await page.getByRole('button', { name: 'Copy S3 URI', exact: true }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('s3://desktop-fixtures/workspace/documents/readme.md');
  await page.getByRole('button', { name: 'Close information' }).click();
  await page.getByLabel('Folder path').getByRole('button', { name: 'Local S3', exact: true }).click();
  await table.getByText('empty', { exact: true }).dblclick();
  await expect(page.getByRole('heading', { name: 'This folder is empty' })).toBeVisible();
  await page.getByLabel('Folder path').getByRole('button', { name: 'Local S3', exact: true }).click();
  const beforePaged = listingRequests;
  await table.getByText('paged', { exact: true }).dblclick();
  await expect(table.getByRole('row')).toHaveCount(1001);
  expect(listingRequests).toBe(beforePaged + 1);
  await expect(page.getByLabel('Page size')).toHaveValue('1000');
  await page.getByLabel('Search file name').fill('item999.txt');
  await expect(page.getByRole('heading', { name: 'No matching items' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('button', { name: 'Next page' }).click();
  await expect(table.getByRole('row')).toHaveCount(6);
  expect(listingRequests).toBe(beforePaged + 2);
  await page.getByLabel('Search file name').fill('item999.txt');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByText('item999.txt')).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByRole('columnheader', { name: 'Name' }).getByRole('button').click();
  await expect(table.locator('tbody tr').first()).toContainText('item999.txt');
  await page.getByRole('button', { name: 'Previous page' }).click();
  await expect(table.getByRole('row')).toHaveCount(1001);
  expect(listingRequests).toBe(beforePaged + 3);
  await page.getByLabel('Page size').selectOption('250');
  await expect(table.getByRole('row')).toHaveCount(251);
  expect(listingRequests).toBe(beforePaged + 4);
  await page.getByLabel('Search range').selectOption('folder');
  await page.getByLabel('Name match').selectOption('contains');
  await page.getByLabel('Search file name').fill('999');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('item999.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Name match').selectOption('prefix');
  await page.getByLabel('Search file name').fill('item999');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('item999.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Search range').selectOption('page');
  await page.getByLabel('Name match').selectOption('contains');
  await captureTestScreenshot(page, 'test-results/folder-pages.png');

  // Refresh really reaches S3 rather than just re-rendering a cached list.
  await server.put('workspace/paged/fresh.txt', 'new');
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await expect(table.getByRole('row')).toHaveCount(251);
  await page.getByLabel('Search file name').fill('fresh.txt');
  await expect(table.getByText('fresh.txt', { exact: true })).toBeVisible();
  await page.getByLabel('Folder path').getByRole('button', { name: 'Local S3', exact: true }).click();
  await checkFolderStats(page, 'paged', 1006, 1005 * Buffer.byteLength('pagination') + Buffer.byteLength('new'));

  // Metadata survives restart; either encrypted credentials survive or the UI asks to reconnect.
  const stored = JSON.parse(await readFile(join(directory, 'connections.json'), 'utf8'));
  expect(stored.connections[0].region).toBeNull();
  expect(stored.connections[0].extraConfig).toEqual(extraConfig);
  expect(JSON.stringify(stored)).not.toContain('test-secret');
  expect(JSON.stringify(stored)).not.toContain('test-access');
  const diskCache = await readFile(join(directory, 'listing-cache.json'), 'utf8');
  expect(diskCache).not.toContain('test-secret');
  expect(diskCache).not.toContain('test-access');
  await app!.close(); app = undefined;
  expect(listingRequests).toBeGreaterThan(0);
  const requestsBeforeCachedStartup = listingRequests;
  page = await launch();
  await expect(page.getByRole('table').getByText('notes.txt', { exact: true })).toBeVisible();
  await checkSavedColumnWidths(page, columnWidths);
  await expect(page.getByText('· Cached', { exact: true })).toBeVisible();
  await expect(page.getByRole('table').locator('tbody tr').filter({ hasText: 'documents' }).locator('time')).toHaveAttribute('datetime', documentsStatsAt);
  expect(listingRequests).toBe(requestsBeforeCachedStartup);
  expect(await app!.evaluate(() => process.getActiveResourcesInfo().includes('ProcessWrap'))).toBe(false);
  await page.getByRole('table').getByText('documents', { exact: true }).dblclick();
  await expect(page.getByRole('table').getByText('readme.md', { exact: true })).toBeVisible();
  expect(listingRequests).toBe(requestsBeforeCachedStartup);

  // With no disk cache, startup stays idle rather than automatically listing S3.
  await app!.close(); app = undefined;
  await rm(join(directory, 'listing-cache.json'));
  const requestsBeforeUncachedStartup = listingRequests;
  page = await launch();
  await expect(page.getByRole('heading', { name: 'Folder not loaded' })).toBeVisible();
  expect(listingRequests).toBe(requestsBeforeUncachedStartup);
  expect(await app!.evaluate(() => process.getActiveResourcesInfo().includes('ProcessWrap'))).toBe(false);
  await expect(page.getByRole('navigation').getByRole('button', { name: /^Local S3/ })).toBeVisible();
  await page.getByRole('button', { name: 'Manage Local S3' }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await expect(page.getByRole('dialog').getByLabel('Region', { exact: false })).toHaveValue('');
  expect(JSON.parse(await page.getByRole('dialog').getByLabel('Extra config (JSON)', { exact: false }).inputValue())).toEqual(extraConfig);
  await page.getByRole('dialog').getByLabel('Access key (AK)').fill('test-access');
  await page.getByRole('dialog').getByLabel('Secret key (SK)').fill('test-secret');
  await page.getByRole('dialog').getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Manage Local S3' }).click();
  await page.getByRole('menuitem', { name: 'Remove connection' }).click();
  await page.getByRole('alertdialog', { name: 'Remove connection?' }).getByRole('button', { name: 'Remove connection', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your cloud. A little closer.' })).toBeVisible();
  expect(errors).toEqual([]);
});

for (const packaged of [false, true]) test(`copies a file and a folder within one connection through the row menu (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Build the packaged application first.');
  await app?.close(); app = undefined;
  const page = await launch(packaged, join(directory, `copy-${packaged ? 'packaged' : 'source'}`));
  await page.getByRole('button', { name: 'Add your first connection' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByLabel('Connection name').fill('Copy fixtures');
  await settings.getByLabel('Endpoint URL').fill(endpoint);
  await settings.getByLabel('Bucket', { exact: true }).fill('desktop-fixtures');
  await settings.getByLabel('Prefix', { exact: false }).fill('workspace/');
  await settings.getByLabel('Extra config (JSON)', { exact: false }).fill(JSON.stringify(extraConfig));
  await settings.getByLabel('Access key (AK)').fill('test-access');
  await settings.getByLabel('Secret key (SK)').fill('test-secret');
  await settings.getByLabel('Allow uploads').check();
  await settings.getByRole('button', { name: 'Connect & browse' }).click();
  const table = page.getByRole('table', { name: 'Folder contents' });
  const copyRow = async (label: string, nextName: string, kind: 'file' | 'folder') => {
    const row = table.locator('tbody tr').filter({ hasText: label }).first();
    await row.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 120, clientY: 150 })));
    await page.getByRole('menuitem', { name: 'Copy to…' }).click();
    const dialog = page.getByRole('dialog', { name: `Copy ${kind}` });
    await expect(dialog.getByRole('textbox', { name: 'Destination S3 folder key' })).toHaveValue('workspace/');
    await dialog.getByRole('textbox', { name: 'New name' }).fill(nextName);
    await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  };
  const suffix = packaged ? '-packaged' : '';
  await copyRow('100% + #.txt', `100% + # (copy${suffix}).txt`, 'file');
  await copyRow('documents', `documents-copy${suffix}`, 'folder');
  const copied = await page.evaluate(async suffix => {
    const id = (await window.s3.connections()).connections[0].id;
    return Promise.all([
      window.s3.searchUri(id, `workspace/100% + # (copy${suffix}).txt`),
      window.s3.searchUri(id, `workspace/documents-copy${suffix}/nested/deep.txt`),
    ]);
  }, suffix);
  expect(copied[0].entries[0]?.key).toBe(`workspace/100% + # (copy${suffix}).txt`);
  expect(copied[1].entries[0]?.key).toBe(`workspace/documents-copy${suffix}/nested/deep.txt`);
});

for (const packaged of [false, true]) test(`renames a file and a folder through the row menu (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Build the packaged application first.');
  await app?.close(); app = undefined;
  const page = await launch(packaged, join(directory, `rename-${packaged ? 'packaged' : 'source'}`));
  await page.getByRole('button', { name: 'Add your first connection' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByLabel('Connection name').fill('Rename fixtures');
  await settings.getByLabel('Endpoint URL').fill(endpoint);
  await settings.getByLabel('Bucket', { exact: true }).fill('desktop-fixtures');
  await settings.getByLabel('Prefix', { exact: false }).fill('workspace/');
  await settings.getByLabel('Extra config (JSON)', { exact: false }).fill(JSON.stringify(extraConfig));
  await settings.getByLabel('Access key (AK)').fill('test-access');
  await settings.getByLabel('Secret key (SK)').fill('test-secret');
  await settings.getByLabel('Allow uploads').check();
  await settings.getByLabel('Allow deletes').check();
  await settings.getByRole('button', { name: 'Connect & browse' }).click();
  const suffix = packaged ? '-packaged' : '-source';
  const sourceFile = `100% + # (rename${suffix}).txt`;
  const sourceFolder = `documents-rename${suffix}`;
  await page.evaluate(async ({ sourceFile, sourceFolder }) => {
    const id = (await window.s3.connections()).connections[0].id;
    await window.s3.copyEntry(id, 'workspace/100% + #.txt', 'file', 'workspace/', sourceFile);
    await window.s3.copyEntry(id, 'workspace/documents/', 'folder', 'workspace/', sourceFolder);
  }, { sourceFile, sourceFolder });
  const table = page.getByRole('table', { name: 'Folder contents' });
  const openRename = async (label: string, kind: 'file' | 'folder') => {
    const row = table.locator('tbody tr').filter({ hasText: label }).first();
    await expect(row).toBeVisible();
    await row.evaluate(element => element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 120, clientY: 150 })));
    await page.getByRole('menuitem', { name: 'Rename…' }).click();
    return page.getByRole('dialog', { name: `Rename ${kind}` });
  };
  const fileDialog = await openRename(sourceFile, 'file');
  await expect(fileDialog.getByRole('button', { name: 'Rename', exact: true })).toBeDisabled();
  await fileDialog.getByRole('textbox', { name: 'New name' }).fill('notes.txt');
  await fileDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(fileDialog.getByRole('alert')).toContainText('destination already exists');
  const renamedFile = `100% + # (renamed${suffix}).txt`;
  await fileDialog.getByRole('textbox', { name: 'New name' }).fill(renamedFile);
  await fileDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(fileDialog).toHaveCount(0);
  const folderDialog = await openRename(sourceFolder, 'folder');
  const renamedFolder = `documents-renamed${suffix}`;
  await folderDialog.getByRole('textbox', { name: 'New name' }).fill(renamedFolder);
  await folderDialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(folderDialog).toHaveCount(0);
  const found = await page.evaluate(async ({ sourceFile, renamedFile, sourceFolder, renamedFolder }) => {
    const id = (await window.s3.connections()).connections[0].id;
    return Promise.all([
      window.s3.searchUri(id, `workspace/${sourceFile}`),
      window.s3.searchUri(id, `workspace/${renamedFile}`),
      window.s3.searchUri(id, `workspace/${sourceFolder}/nested/deep.txt`),
      window.s3.searchUri(id, `workspace/${renamedFolder}/nested/deep.txt`),
    ]);
  }, { sourceFile, renamedFile, sourceFolder, renamedFolder });
  expect(found.map(result => result.entries.length)).toEqual([0, 1, 0, 1]);
});

test('packaged app lists real S3 objects without Python', async () => {
  test.skip(!existsSync(packagedExecutable), 'Run npm run pack to include the packaged application smoke test.');
  await app?.close(); app = undefined;
  const page = await launch(true);
  expect(await app!.evaluate(({ app }) => app.isPackaged)).toBe(true);
  await page.getByRole('button', { name: 'Add your first connection' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Connection name').fill('Packaged S3');
  await dialog.getByLabel('Endpoint URL').fill(endpoint);
  await dialog.getByLabel('Region', { exact: false }).fill('');
  await dialog.getByLabel('Prefix', { exact: false }).fill('s3://desktop-fixtures/workspace/documents/');
  await dialog.getByLabel('Extra config (JSON)', { exact: false }).fill(JSON.stringify(extraConfig));
  await dialog.getByLabel('Access key (AK)').fill('test-access');
  await dialog.getByLabel('Secret key (SK)').fill('test-secret');
  await dialog.getByRole('button', { name: 'Connect & browse' }).click();
  const table = page.getByRole('table', { name: 'Folder contents' });
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  await expect(table.getByText('deep.txt')).toHaveCount(0);
  await page.getByLabel('Search file name').fill('readme.md');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  await page.getByLabel('Search range').selectOption('recursive');
  await page.getByLabel('Search file name').fill('deep.txt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('nested/deep.txt', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();
  const columnWidths = await checkColumnResizing(page);
  await page.getByRole('button', { name: 'Manage Packaged S3' }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await expect(dialog.getByLabel('Region', { exact: false })).toHaveValue('');
  await expect(dialog.getByLabel('Access key (AK)')).toHaveValue('test-access');
  await checkSavedSecret(dialog);
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  const nestedStatsAt = await checkFolderStats(page, 'nested', 1, Buffer.byteLength('Only visible inside nested.'));
  await checkConnectionCopy(page, 'Packaged S3', 'workspace/documents/');
  await app!.close(); app = undefined;
  const requestsBeforeRestart = listingRequests;
  const restored = await launch(true);
  await expect(restored.getByRole('table').getByText('readme.md', { exact: true })).toBeVisible();
  await checkSavedColumnWidths(restored, columnWidths);
  await expect(restored.getByText('· Cached', { exact: true })).toBeVisible();
  await expect(restored.getByRole('table').locator('tbody tr').filter({ hasText: 'nested' }).locator('time')).toHaveAttribute('datetime', nestedStatsAt);
  expect(listingRequests).toBe(requestsBeforeRestart);
  expect(await app!.evaluate(() => process.getActiveResourcesInfo().includes('ProcessWrap'))).toBe(false);
  await captureTestScreenshot(restored, 'test-results/packaged-app.png');
  expect(errors).toEqual([]);
});

for (const packaged of [false, true]) test(`Escape exits native fullscreen and leaves ordinary Escape handling alone (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Build the packaged application first.');
  await app?.close(); app = undefined;
  await launch(packaged, join(directory, `fullscreen-shortcut-${packaged ? 'packaged' : 'source'}`));
  const behavior = await app!.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const originalIs = win.isFullScreen;
    const originalSet = win.setFullScreen;
    let full = false;
    const calls: boolean[] = [];
    let prevented = 0;
    win.isFullScreen = () => full;
    win.setFullScreen = value => { calls.push(value); };
    const escape = () => win.webContents.emit('before-input-event', { preventDefault: () => { prevented++; } } as Electron.Event, { type: 'keyDown', key: 'Escape' } as Electron.Input);
    try {
      escape();
      const normal = { calls: [...calls], prevented };
      full = true;
      escape();
      const native = { calls: [...calls], prevented };
      win.emit('enter-html-full-screen');
      escape();
      const html = { calls: [...calls], prevented };
      return { normal, native, html };
    } finally {
      win.isFullScreen = originalIs;
      win.setFullScreen = originalSet;
    }
  });
  expect(behavior.normal).toEqual({ calls: [], prevented: 0 });
  expect(behavior.native).toEqual({ calls: [false], prevented: 1 });
  expect(behavior.html).toEqual({ calls: [false], prevented: 1 });
});

for (const packaged of [false, true]) test(`Window Zoom toggles maximize and restore (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Build the packaged application first.');
  await app?.close(); app = undefined;
  await launch(packaged, join(directory, `window-zoom-${packaged ? 'packaged' : 'source'}`));
  const result = await app!.evaluate(({ BrowserWindow, Menu }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const zoom = Menu.getApplicationMenu()?.items.find(item => item.label === 'Window')?.submenu?.items.find(item => item.label === 'Zoom');
    if (!zoom) return { found: false, calls: [] as string[] };
    const originalIs = win.isMaximized;
    const originalMaximize = win.maximize;
    const originalUnmaximize = win.unmaximize;
    let maximized = false;
    const calls: string[] = [];
    win.isMaximized = () => maximized;
    win.maximize = () => { calls.push('maximize'); maximized = true; };
    win.unmaximize = () => { calls.push('unmaximize'); maximized = false; };
    try { zoom.click(); zoom.click(); return { found: true, calls }; }
    finally { win.isMaximized = originalIs; win.maximize = originalMaximize; win.unmaximize = originalUnmaximize; }
  });
  expect(result).toEqual({ found: true, calls: ['maximize', 'unmaximize'] });
});

for (const packaged of [false, true]) test(`remembers window and pane sizes, then resets them from View (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Run npm run pack for the packaged size test.');
  const profile = join(directory, `size-preferences-${packaged ? 'packaged' : 'source'}`);
  await mkdir(profile);
  let page = await launch(packaged, profile);
  const size = () => app!.evaluate(({ BrowserWindow }) => {
    const { width, height } = BrowserWindow.getAllWindows()[0].getNormalBounds();
    return { width, height };
  });
  await expect.poll(size).toEqual({ width: 1200, height: 800 });
  let sidebar = page.getByRole('separator', { name: 'Resize sidebar' });
  await sidebar.focus(); await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveAttribute('aria-valuenow', '260');
  await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1370, 760));
  await expect.poll(size).toEqual({ width: 1370, height: 760 });
  await page.evaluate(() => localStorage.setItem('s3-client.file-column-widths.v1', JSON.stringify({ name: 390 })));
  await app!.close(); app = undefined;

  page = await launch(packaged, profile);
  await expect.poll(size).toEqual({ width: 1370, height: 760 });
  sidebar = page.getByRole('separator', { name: 'Resize sidebar' });
  await expect(sidebar).toHaveAttribute('aria-valuenow', '260');
  const menu = await app!.evaluate(({ Menu }) => {
    const items = Menu.getApplicationMenu()?.items ?? [];
    return {
      topLevel: items.map(item => item.label),
      view: items.find(item => item.label === 'View')?.submenu?.items.map(item => item.label),
    };
  });
  expect(menu.topLevel).not.toContain('File');
  expect(menu.topLevel).not.toContain('Edit');
  expect(menu.view).toContain('Reset Sizes to Default');
  await app!.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('reset-view-sizes');
    if (!item) throw new Error('Reset Sizes to Default menu item is missing.');
    item.click();
  });
  await expect.poll(size).toEqual({ width: 1200, height: 800 });
  await expect(sidebar).toHaveAttribute('aria-valuenow', '250');
  expect(await page.evaluate(() => localStorage.getItem('s3-client.file-column-widths.v1'))).toBeNull();
  await app!.close(); app = undefined;

  page = await launch(packaged, profile);
  await expect.poll(size).toEqual({ width: 1200, height: 800 });
  await expect(page.getByRole('separator', { name: 'Resize sidebar' })).toHaveAttribute('aria-valuenow', '250');
});

for (const packaged of [false, true]) test(`drags connections into a saved order (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Run npm run pack for the packaged drag test.');
  const profile = join(directory, `connection-order-${packaged ? 'packaged' : 'source'}`);
  await mkdir(profile);
  let page = await launch(packaged, profile);
  await page.evaluate(async endpoint => {
    for (const name of ['First', 'Second', 'Third']) {
      await window.s3.saveConnection({ name, endpoint, bucket: 'desktop-fixtures', prefix: 'workspace/', region: null, accessKey: 'test-access', secretKey: 'test-secret' });
    }
  }, endpoint);
  await page.reload();

  const rootRows = () => page.locator('.tree > div > .root-node');
  const rootNames = () => rootRows().locator('.tree-select > span:first-of-type').allTextContents();
  await expect.poll(rootNames).toEqual(['First', 'Second', 'Third']);
  await rootRows().nth(2).dragTo(rootRows().nth(0), { targetPosition: { x: 20, y: 5 } });
  await expect.poll(rootNames).toEqual(['Third', 'First', 'Second']);
  await rootRows().nth(1).dragTo(rootRows().nth(2), { targetPosition: { x: 20, y: 27 } });
  await expect.poll(rootNames).toEqual(['Third', 'Second', 'First']);
  await expect.poll(async () => (await page.evaluate(() => window.s3.connections())).connections.map(item => item.name)).toEqual(['Third', 'Second', 'First']);
  await expect(page.locator('.root-node.selected .tree-select')).toContainText('First');

  await app!.close(); app = undefined;
  page = await launch(packaged, profile);
  await expect.poll(rootNames).toEqual(['Third', 'Second', 'First']);
  await expect(page.locator('.root-node.selected .tree-select')).toContainText('Third');
});

for (const packaged of [false, true]) test(`uses a connection page size across folders and restores its default on restart (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Run npm run pack for the packaged page-size test.');
  const profile = join(directory, `connection-page-size-${packaged ? 'packaged' : 'source'}`);
  await mkdir(profile);
  let page = await launch(packaged, profile);
  await page.evaluate(async endpoint => {
    for (const [name, defaultPageSize] of [['First', 500], ['Second', 100]] as const) {
      await window.s3.saveConnection({ name, endpoint, bucket: 'desktop-fixtures', prefix: 'workspace/', region: null, defaultPageSize, accessKey: 'test-access', secretKey: 'test-secret' });
    }
  }, endpoint);
  await page.reload();
  await page.getByRole('button', { name: 'List folder' }).click();
  const table = page.getByRole('table', { name: 'Folder contents' });
  await expect(page.getByLabel('Page size')).toHaveValue('500');
  await page.getByLabel('Page size').selectOption('250');
  await expect(page.getByLabel('Page size')).toHaveValue('250');
  await table.getByText('documents', { exact: true }).dblclick();
  await expect(page.getByLabel('Page size')).toHaveValue('250');
  await page.getByLabel('Folder path').getByRole('button', { name: 'First' }).click();
  await table.getByText('paged', { exact: true }).dblclick();
  await expect(page.getByLabel('Page size')).toHaveValue('250');
  await page.locator('.root-node .tree-select').filter({ hasText: 'Second' }).click();
  await expect(page.getByLabel('Page size')).toHaveValue('100');
  await page.locator('.root-node .tree-select').filter({ hasText: 'First' }).click();
  await expect(page.getByLabel('Page size')).toHaveValue('250');
  await page.getByRole('button', { name: 'Manage First' }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  await expect(page.getByRole('dialog').getByLabel('Default page size')).toHaveValue('500');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await app!.close(); app = undefined;

  page = await launch(packaged, profile);
  await expect(page.getByLabel('Page size')).toHaveValue('500');
  await expect(page.locator('.root-node.selected .tree-select')).toContainText('First');
});

for (const packaged of [false, true]) test(`plays an MP4 through private S3 byte-range streaming (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Run npm run pack for the packaged video test.');
  const fixture = join(root, 'tests/fixtures/sample.mp4');
  await server.put('video-preview/sample.mp4', await readFile(fixture), 'video/mp4');
  const profile = join(directory, `video-preview-${packaged ? 'packaged' : 'source'}`);
  await mkdir(profile);
  const page = await launch(packaged, profile);
  await page.evaluate(async endpoint => {
    await window.s3.saveConnection({ name: 'Video S3', endpoint, bucket: 'desktop-fixtures', prefix: 'video-preview/', region: null, accessKey: 'test-access', secretKey: 'test-secret' });
  }, endpoint);
  await page.reload();
  await page.getByRole('button', { name: 'List folder' }).click();
  await page.getByRole('table').getByText('sample.mp4', { exact: true }).dblclick();
  const player = page.getByRole('dialog', { name: 'Play sample.mp4' });
  await expect(player).toBeVisible();
  await expect(page.getByText('Streaming from S3')).toBeVisible();
  expect(await page.evaluate(() => document.fullscreenEnabled)).toBe(true);
  const grip = player.getByRole('button', { name: 'Resize video player' });
  const before = await player.boundingBox();
  const gripBox = await grip.boundingBox();
  if (!before || !gripBox) throw new Error('Video player resize handle is missing.');
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 + 100, gripBox.y + gripBox.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await player.boundingBox())?.width).toBeCloseTo(before.width + 100, 0);
  await expect.poll(async () => (await player.boundingBox())?.height).toBeCloseTo(before.height + 60, 0);
  await expect(player.getByRole('button', { name: 'Enter fullscreen' })).toBeVisible();
  const video = page.locator('video');
  const url = await video.getAttribute('src');
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v\//);
  const response = await fetch(url!, { headers: { Range: 'bytes=0-31' } });
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toMatch(/^bytes 0-31\/\d+$/);
  expect(Buffer.from(await response.arrayBuffer())).toEqual((await readFile(fixture)).subarray(0, 32));
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).videoWidth)).toBe(160);
  await page.getByRole('button', { name: 'Close video' }).click();
  await expect(page.getByRole('dialog', { name: 'Play sample.mp4' })).toHaveCount(0);
  await page.getByRole('table').getByText('sample.mp4', { exact: true }).dblclick();
  await expect.poll(async () => (await player.boundingBox())?.width).toBeCloseTo(before.width + 100, 0);
  await app!.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('reset-view-sizes')?.click());
  await expect.poll(async () => (await player.boundingBox())?.width).toBeCloseTo(before.width, 0);
  await page.getByRole('button', { name: 'Close video' }).click();
});

for (const packaged of [false, true]) test(`finds an exact full S3 key across the connection (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Run npm run pack for the packaged key search test.');
  const profile = join(directory, `key-search-${packaged ? 'packaged' : 'source'}`);
  await mkdir(profile);
  const page = await launch(packaged, profile);
  await page.evaluate(async endpoint => {
    await window.s3.saveConnection({ name: 'Key S3', endpoint, bucket: 'desktop-fixtures', prefix: 'workspace/', region: null, accessKey: 'test-access', secretKey: 'test-secret' });
  }, endpoint);
  await page.reload();
  await page.getByRole('button', { name: 'List folder' }).click();
  const table = page.getByRole('table', { name: 'Folder contents' });
  await table.getByText('documents', { exact: true }).dblclick();
  await expect(page.getByLabel('Folder path')).toContainText('documents');
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  const before = listingRequests;
  await page.getByLabel('Search range').selectOption('key');
  await expect(page.getByLabel('Name match')).toBeDisabled();
  await page.getByRole('textbox', { name: 'Full S3 key' }).fill('workspace/100% + #.txt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('workspace/100% + #.txt', { exact: true })).toBeVisible();
  expect(listingRequests).toBe(before);
  await page.getByRole('textbox', { name: 'Full S3 key' }).fill('outside-root.txt');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('outside this connection');
  expect(listingRequests).toBe(before);
  await page.getByRole('textbox', { name: 'Full S3 key' }).fill('workspace/empty/');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(table.getByText('workspace/empty/', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Full S3 key' }).fill('workspace/photos');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await table.getByText('workspace/photos/', { exact: true }).dblclick();
  await expect(page.getByLabel('Folder path')).toContainText('photos');
  await expect(table.getByText('summer.jpg', { exact: true })).toBeVisible();
});

for (const packaged of [false, true]) test(`copies connection URIs with a saved URI scheme (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Run npm run pack for the packaged URI scheme test.');
  const profile = join(directory, `uri-scheme-${packaged ? 'packaged' : 'source'}`);
  await mkdir(profile);
  let page = await launch(packaged, profile);
  await page.getByRole('button', { name: 'Add connection' }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Connect your storage' });
  await expect(dialog.getByLabel('URI scheme')).toHaveValue('s3');
  await dialog.getByLabel('Connection name').fill('Scheme S3');
  await dialog.getByLabel('Endpoint URL').fill(endpoint);
  await dialog.getByLabel('URI scheme').fill('obs');
  await dialog.getByLabel('Prefix', { exact: false }).fill('obs://desktop-fixtures/workspace/');
  await dialog.getByLabel('Access key (AK)').fill('test-access');
  await dialog.getByLabel('Secret key (SK)').fill('test-secret');
  await dialog.getByRole('button', { name: 'Connect & browse' }).click();
  const table = page.getByRole('table', { name: 'Folder contents' });
  await table.getByText('documents', { exact: true }).dblclick();
  await expect(table.getByText('readme.md', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy folder OBS URI' }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('obs://desktop-fixtures/workspace/documents/');
  await table.getByText('readme.md', { exact: true }).click();
  await page.getByRole('button', { name: 'Toggle item information' }).click();
  await page.getByRole('button', { name: 'Copy OBS URI' }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('obs://desktop-fixtures/workspace/documents/readme.md');
  await app!.evaluate(({ clipboard }) => clipboard.writeText('clipboard-before-row-copy'));
  const fileRow = table.getByRole('row').filter({ hasText: 'readme.md' });
  await fileRow.focus();
  await expect(fileRow).toBeFocused();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('obs://desktop-fixtures/workspace/documents/readme.md');
  await page.getByRole('button', { name: 'Manage Scheme S3' }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit connection' });
  await expect(dialog.getByLabel('URI scheme')).toHaveValue('obs');
  await dialog.getByLabel('URI scheme').fill('oss');
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByRole('button', { name: 'Copy folder OSS URI' })).toBeVisible();
  await page.getByRole('button', { name: 'Copy folder OSS URI' }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('oss://desktop-fixtures/workspace/');
  await app!.close(); app = undefined;

  page = await launch(packaged, profile);
  await page.getByRole('button', { name: 'Manage Scheme S3' }).click();
  await page.getByRole('menuitem', { name: 'Copy connection' }).click();
  await page.getByRole('button', { name: 'Manage Scheme S3 (copy)' }).click();
  await page.getByRole('menuitem', { name: 'Edit connection' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit connection' });
  await expect(dialog.getByLabel('URI scheme')).toHaveValue('oss');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('button', { name: 'Manage Scheme S3 (copy)' }).click();
  await page.getByRole('menuitem', { name: 'Remove connection' }).click();
  await expect(page.getByRole('alertdialog').getByText('oss://desktop-fixtures/workspace/', { exact: true })).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
});

for (const packaged of [false, true]) test(`searches a URI across connections (${packaged ? 'packaged' : 'source'})`, async () => {
  if (packaged) test.skip(!existsSync(packagedExecutable), 'Run npm run pack for the packaged URI search test.');
  const profile = join(directory, `cross-uri-${packaged ? 'packaged' : 'source'}`);
  await mkdir(profile);
  const page = await launch(packaged, profile);
  await page.getByRole('button', { name: 'Add connection' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Connect your storage' });
  await dialog.getByLabel('Connection name').fill('URI Search S3');
  await dialog.getByLabel('Endpoint URL').fill(endpoint);
  await dialog.getByLabel('Bucket', { exact: true }).fill('desktop-fixtures');
  await dialog.getByLabel('Prefix', { exact: false }).fill('workspace/photos/');
  await dialog.getByLabel('Access key (AK)').fill('test-access');
  await dialog.getByLabel('Secret key (SK)').fill('test-secret');
  await dialog.getByRole('button', { name: 'Connect & browse' }).click();
  await expect(dialog).toHaveCount(0);
  const input = page.getByRole('textbox', { name: 'Search URI across connections' });
  await input.fill('obs://desktop-fixtures/workspace/documents/readme.md');
  await expect(input).toHaveValue('obs://desktop-fixtures/workspace/documents/readme.md');
  await expect(page.getByRole('button', { name: 'Go to URI' })).toBeEnabled();
  await page.getByRole('button', { name: 'Go to URI' }).click();
  await expect(page.getByRole('alert')).toContainText('No connection for obs://desktop-fixtures');
  await input.fill('s3://desktop-fixtures/workspace/documents/readme.md');
  await page.getByRole('button', { name: 'Go to URI' }).click();
  const table = page.getByRole('table', { name: 'Folder contents' });
  await expect(table.getByText('workspace/documents/readme.md', { exact: true })).toBeVisible();
  await expect(page.locator('.uri-result-banner')).toContainText('Using URI Search S3');
  await expect(page.locator('.uri-result-banner')).toContainText('outside this connection’s browsing prefix');
  await expect(table.getByRole('button', { name: 'Download workspace/documents/readme.md' })).toHaveCount(0);
  const fileRow = table.getByRole('row').filter({ hasText: 'workspace/documents/readme.md' });
  await fileRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy URI' }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('s3://desktop-fixtures/workspace/documents/readme.md');
  await fileRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy S3 key' }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('workspace/documents/readme.md');
  await fileRow.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy file name' }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('readme.md');
  await input.fill('s3://desktop-fixtures/workspace/documents');
  await page.getByRole('button', { name: 'Go to URI' }).click();
  await expect(table.getByText('workspace/documents/', { exact: true })).toBeVisible();
  await table.getByRole('row').filter({ hasText: 'workspace/documents/' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy folder name' }).click();
  expect(await app!.evaluate(({ clipboard }) => clipboard.readText())).toBe('documents');
});
