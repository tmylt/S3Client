import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { chromium } from '@playwright/test';

// Render the built app with invented data. This never reads the user's S3 profile.
const root = resolve('out/renderer');
const output = resolve('docs/images');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (file !== resolve(root, 'index.html') && !file.startsWith(root + sep)) throw new Error('Invalid path');
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
});

const connection = {
  id: 'demo', name: 'Demo storage', endpoint: 'https://s3.example.test', bucket: 'project-files',
  uriScheme: 's3', prefix: '', region: 'us-east-1', defaultPageSize: 1000, hasCredentials: true,
  permissions: { download: true, upload: true, delete: true },
};
const folder = (name, prefix = '') => ({ key: `${prefix}${name}/`, name, kind: 'folder', size: null, modified: null });
const file = (name, size, date, prefix = '') => ({ key: `${prefix}${name}`, name, kind: 'file', size, modified: date });
const rootEntries = [
  folder('documents'), folder('media'), folder('reports'),
  file('README.md', 3421, '2026-10-29T14:25:42Z'),
  file('project-plan.pdf', 284672, '2026-10-27T09:14:08Z'),
  file('team-photo.jpg', 1843257, '2026-10-21T16:38:03Z'),
];
const listings = {
  '': rootEntries,
  'documents/': [folder('contracts', 'documents/'), file('notes.txt', 9217, '2026-10-25T10:20:00Z', 'documents/')],
  'media/': [file('intro.mp4', 32513536, '2026-10-22T08:00:00Z', 'media/')],
  'reports/': [folder('2026', 'reports/'), file('overview.pdf', 502104, '2026-10-30T17:43:19Z', 'reports/')],
};
const searchEntries = [
  file('invoice-105.pdf', 92871, '2026-10-30T11:05:17Z', 'documents/contracts/'),
  file('invoice-106.pdf', 85302, '2026-10-31T08:42:06Z', 'documents/contracts/'),
  file('invoices-2026.csv', 14793, '2026-10-28T15:35:29Z', 'reports/2026/'),
];
const transfers = {
  tasks: [
    { id: 'download-1', groupId: 'group-1', direction: 'download', connectionId: 'demo', connectionName: 'Demo storage', bucket: 'project-files', key: 'reports/2026/archive.zip', relativePath: 'archive.zip', localPath: '/home/demo/Downloads/archive.zip', rootPath: '/home/demo/Downloads', size: 52428800, transferred: 19398656, bytesPerSecond: 1200000, isDirectory: false, status: 'running', createdAt: '2026-11-02T09:00:00Z' },
    { id: 'download-2', groupId: 'group-2', direction: 'download', connectionId: 'demo', connectionName: 'Demo storage', bucket: 'project-files', key: 'README.md', relativePath: 'README.md', localPath: '/home/demo/Downloads/README.md', rootPath: '/home/demo/Downloads', size: 3421, transferred: 3421, isDirectory: false, status: 'completed', createdAt: '2026-11-02T08:50:00Z', finishedAt: '2026-11-02T08:50:01Z' },
  ],
  preparations: [], paused: { download: false, upload: false }, concurrency: { download: 1, upload: 1 },
};

let browser;
try {
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  await mkdir(output, { recursive: true });
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(data => {
    const noOp = () => {};
    const unsubscribe = () => noOp;
    window.s3 = {
      connections: async () => ({ connections: [data.connection], secureStorage: true, cachedListings: [{ connectionId: 'demo', prefix: '', entries: data.rootEntries, updatedAt: '2026-11-02T09:00:00Z' }] }),
      connectionDetails: async () => ({ ...data.connection, accessKey: 'DEMO_ACCESS_KEY', secretKey: 'demo-secret-key' }),
      list: async (_id, prefix) => ({ entries: data.listings[prefix] || [], nextToken: null }),
      search: async () => ({ entries: data.searchEntries, nextToken: null }),
      searchUri: async () => ({ entries: [], nextToken: null }),
      stats: async () => ({ fileCount: 3, totalSize: 900000, updatedAt: '2026-11-02T09:00:00Z', durationMs: 340 }),
      transfers: async () => data.transfers,
      onTransfers: unsubscribe, onStorageChanged: unsubscribe, onConfirmation: unsubscribe,
      onResetViewSizes: unsubscribe, onVideoEvent: unsubscribe,
      copyText: async () => {},
    };
  }, { connection, rootEntries, listings, searchEntries, transfers });
  const address = server.address();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.getByRole('table', { name: 'Folder contents' }).waitFor();
  await page.getByRole('button', { name: 'Refresh folder', exact: true }).click();
  await page.getByRole('table', { name: 'Folder contents' }).getByText('project-plan.pdf').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${output}/browser.png` });

  await page.getByRole('button', { name: 'Add connection', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Connect your storage' });
  await dialog.getByLabel('Connection name').fill('My project files');
  await dialog.getByLabel('Endpoint URL').fill('https://s3.example.test');
  await dialog.getByLabel('Bucket', { exact: true }).fill('project-files');
  await dialog.getByLabel('Prefix', { exact: false }).fill('reports/');
  await dialog.screenshot({ path: `${output}/connection.png` });
  await dialog.getByLabel('Access key (AK)').fill('DEMO_ACCESS_KEY');
  await dialog.getByLabel('Secret key (SK)').fill('demo-secret-key');
  await dialog.evaluate(element => { element.scrollTop = element.scrollHeight; });
  const connectionBox = await dialog.boundingBox();
  if (!connectionBox) throw new Error('Connection dialog is missing.');
  await page.screenshot({ path: `${output}/credentials.png`, clip: { x: connectionBox.x, y: connectionBox.y + connectionBox.height - 440, width: connectionBox.width, height: 440 } });
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await page.getByRole('combobox', { name: 'Search range' }).selectOption('recursive');
  await page.getByRole('combobox', { name: 'Name match' }).selectOption('contains');
  await page.getByRole('textbox', { name: 'Search file name' }).fill('invoice');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('table', { name: 'Folder contents' }).getByText('invoice-105.pdf').waitFor();
  await page.screenshot({ path: `${output}/search.png` });

  await page.getByRole('button', { name: /Downloads/ }).click();
  const downloads = page.getByRole('dialog', { name: 'Downloads' });
  await downloads.waitFor();
  await downloads.screenshot({ path: `${output}/downloads.png` });
  if (errors.length) throw new Error(`Renderer errors: ${errors.join('; ')}`);
  console.log('Saved five demo screenshots in docs/images/');
} finally {
  await browser?.close();
  await new Promise(resolveClose => server.close(resolveClose));
}
