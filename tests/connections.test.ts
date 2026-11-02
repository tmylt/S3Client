import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStore, normalizeConnection, validatePrefix, type SecretStorage } from '../src/main/connections';
import type { ConnectionInput } from '../src/shared/types';

const input: ConnectionInput = { name: 'Warehouse', endpoint: 'http://localhost:9000', bucket: 'logs', prefix: 'team', region: '', accessKey: 'TOP_SECRET_AK', secretKey: 'TOP_SECRET_SK' };
const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 's3-connections-')); directories.push(path); return path; }
const secure = (): SecretStorage => ({
  isAvailable: async () => true,
  encrypt: async value => Buffer.from(value).reverse(),
  decrypt: async value => Buffer.from(value).reverse().toString(),
});
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

describe('S3 connection boundaries', () => {
  it('parses s3 URIs without interpreting raw object-key syntax', () => {
    expect(normalizeConnection({ ...input, bucket: 's3://other/a//../b\\c%20?x#z', prefix: '' })).toMatchObject({ bucket: 'other', prefix: 'a//../b\\c%20?x#z/', region: null });
    expect(normalizeConnection({ ...input, prefix: 's3://other/a/' })).toMatchObject({ bucket: 'other', prefix: 'a/' });
    expect(normalizeConnection({ ...input, prefix: '/a//./b/' }).prefix).toBe('/a//./b/');
    expect(normalizeConnection({ ...input, bucket: 's3://other/with trailing space ', prefix: '' }).prefix).toBe('with trailing space /');
  });
  it('requires slash-delimited containment and preserves directory key boundaries', () => {
    expect(validatePrefix('team/', 'team/a//../b\\c/')).toBe('team/a//../b\\c/');
    expect(validatePrefix('team/', 'team')).toBe('team/');
    expect(validatePrefix('', '//x/')).toBe('//x/');
    expect(() => validatePrefix('team/', 'teammate/')).toThrow(/outside/i);
    expect(() => validatePrefix('team/', '')).toThrow(/outside/i);
  });
  it('rejects unsafe endpoints and invalid connection fields', () => {
    for (const endpoint of ['file:///tmp/a', 'ftp://example.com', 'https://ak:sk@example.com']) expect(() => normalizeConnection({ ...input, endpoint })).toThrow(/endpoint/i);
    for (const bucket of ['', 'a/b', 'a\\b']) expect(() => normalizeConnection({ ...input, bucket })).toThrow(/bucket/i);
    expect(() => normalizeConnection({ ...input, name: '  ' })).toThrow(/name/i);
  });
  it('preserves an unset region instead of storing the runtime signing default', () => {
    for (const region of [null, '', '  ']) expect(normalizeConnection({ ...input, region }).region).toBeNull();
    expect(normalizeConnection({ ...input, region: 'eu-west-2' }).region).toBe('eu-west-2');
  });
  it('uses 1,000 as the default page size and accepts only supported sizes', () => {
    expect(normalizeConnection(input).defaultPageSize).toBe(1000);
    for (const size of [100, 250, 500, 1000]) expect(normalizeConnection({ ...input, defaultPageSize: size }).defaultPageSize).toBe(size);
    for (const size of [0, 200, 2000, '250', null]) expect(() => normalizeConnection({ ...input, defaultPageSize: size as number })).toThrow(/page size/i);
  });
  it('defaults URI scheme to s3 and validates custom schemes', () => {
    expect(normalizeConnection(input).uriScheme).toBe('s3');
    expect(normalizeConnection({ ...input, uriScheme: ' OBS ' }).uriScheme).toBe('obs');
    expect(normalizeConnection({ ...input, uriScheme: 'oss' }).uriScheme).toBe('oss');
    for (const uriScheme of ['', '1obs', 'obs://bucket', 'obs/path', 'obs space']) {
      expect(() => normalizeConnection({ ...input, uriScheme })).toThrow(/URI scheme/i);
    }
    expect(normalizeConnection({ ...input, uriScheme: 'obs', prefix: 'obs://other/a/' })).toMatchObject({ bucket: 'other', prefix: 'a/', uriScheme: 'obs' });
    expect(normalizeConnection({ ...input, provider: 'obs' }).uriScheme).toBe('obs');
    expect(normalizeConnection({ ...input, provider: 'obs', uriScheme: 'oss' }).uriScheme).toBe('oss');
  });
});

describe('ConnectionStore', () => {
  it('restores and copies a configured default page size, including older settings', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save({ ...input, defaultPageSize: 250 });
    expect(saved.defaultPageSize).toBe(250);
    expect((await new ConnectionStore(path, secure()).connections()).connections[0].defaultPageSize).toBe(250);
    expect((await store.copy(saved.id)).defaultPageSize).toBe(250);
    const settings = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8'));
    delete settings.connections[0].defaultPageSize;
    await writeFile(join(path, 'connections.json'), JSON.stringify(settings));
    expect((await new ConnectionStore(path, secure()).connections()).connections[0].defaultPageSize).toBe(1000);
  });
  it('restores, edits, and copies URI scheme while migrating the old provider field', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save({ ...input, uriScheme: 'obs' });
    expect(saved.uriScheme).toBe('obs');
    expect((await new ConnectionStore(path, secure()).connections()).connections[0].uriScheme).toBe('obs');
    expect((await store.copy(saved.id)).uriScheme).toBe('obs');
    await store.save({ ...input, id: saved.id, uriScheme: 'oss', secretKey: '' });
    expect((await store.connectionDetails(saved.id)).uriScheme).toBe('oss');
    const settings = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8'));
    expect(settings.connections[0].uriScheme).toBe('oss');
    expect(settings.connections[0].provider).toBeUndefined();
    delete settings.connections[0].uriScheme;
    settings.connections[0].provider = 'obs';
    await writeFile(join(path, 'connections.json'), JSON.stringify(settings));
    const legacyStore = new ConnectionStore(path, secure());
    expect((await legacyStore.connections()).connections[0].uriScheme).toBe('obs');
    const upgradedOnLoad = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8'));
    expect(upgradedOnLoad.connections[0].uriScheme).toBe('obs');
    expect(upgradedOnLoad.connections[0].provider).toBeUndefined();
    await legacyStore.save({ ...input, id: saved.id, uriScheme: 'oss', secretKey: '' });
    const migrated = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8'));
    expect(migrated.connections[0].uriScheme).toBe('oss');
    expect(migrated.connections[0].provider).toBeUndefined();
    delete migrated.connections[0].uriScheme;
    await writeFile(join(path, 'connections.json'), JSON.stringify(migrated));
    expect((await new ConnectionStore(path, secure()).connections()).connections[0].uriScheme).toBe('s3');
  });
  it('saves a new connection order and restores it without changing credentials', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const first = await store.save({ ...input, name: 'First' });
    const second = await store.save({ ...input, name: 'Second' });
    const third = await store.save({ ...input, name: 'Third' });
    const before = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8')).connections;

    await store.reorder([third.id, first.id, second.id]);

    expect((await store.connections()).connections.map(item => item.name)).toEqual(['Third', 'First', 'Second']);
    expect((await new ConnectionStore(path, secure()).connections()).connections.map(item => item.name)).toEqual(['Third', 'First', 'Second']);
    const after = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8')).connections;
    for (const record of before) expect(after.find((item: { id: string }) => item.id === record.id)).toEqual(record);
  });

  it('rejects incomplete or duplicate reorder requests without changing saved order', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const first = await store.save({ ...input, name: 'First' });
    const second = await store.save({ ...input, name: 'Second' });
    for (const ids of [[first.id], [first.id, first.id], [first.id, 'missing'], 'bad']) {
      await expect(store.reorder(ids)).rejects.toThrow(/order/i);
    }
    expect((await store.connections()).connections.map(item => item.id)).toEqual([first.id, second.id]);
  });

  it('authorizes each enabled operation and returns the unchanged worker credential/config shape', async () => {
    const path = await directory();
    const extraConfig = { s3: { addressing_style: 'virtual' } };
    const saved = await new ConnectionStore(path, secure()).save({ ...input, region: null, extraConfig, sessionToken: 'PRIVATE_TOKEN', permissions: { download: true, upload: true, delete: true } });
    const store = new ConnectionStore(path, secure());
    for (const operation of ['download', 'upload', 'delete'] as const) {
      const authorized = await store.forOperation(saved.id, 'team/report.csv', operation, 'file');
      expect(authorized).toEqual({ connectionName: saved.name, key: 'team/report.csv', connection: (await store.forListing(saved.id, 'team/')).connection });
      expect(authorized.connection).toMatchObject({ region: 'us-east-1', accessKey: input.accessKey, secretKey: input.secretKey, sessionToken: 'PRIVATE_TOKEN', extraConfig });
    }
  });
  it('denies disabled operations before decrypting credentials and keeps listing available', async () => {
    const path = await directory();
    const saved = await new ConnectionStore(path, secure()).save({ ...input, permissions: { download: false, upload: false, delete: false } });
    let decrypts = 0;
    const crypto = secure();
    const store = new ConnectionStore(path, { ...crypto, decrypt: async value => { decrypts++; return crypto.decrypt(value); } });
    for (const operation of ['download', 'upload', 'delete'] as const) {
      await expect(store.forOperation(saved.id, 'team/file', operation, 'file')).rejects.toThrow(/permission|not allowed|disabled/i);
    }
    expect(decrypts).toBe(0);
    expect((await store.forListing(saved.id, 'team/')).connection.secretKey).toBe(input.secretKey);
    expect(decrypts).toBe(1);
  });
  it('rechecks edited permissions and removed connections through the serial queue', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save(input);
    await expect(store.forOperation(saved.id, 'team/file', 'download', 'file')).resolves.toMatchObject({ key: 'team/file' });
    const edit = store.save({ ...input, id: saved.id, accessKey: '', secretKey: '', permissions: { download: false } });
    const recheck = store.forOperation(saved.id, 'team/file', 'download', 'file');
    await edit;
    await expect(recheck).rejects.toThrow(/permission|not allowed|disabled/i);
    const removal = store.remove(saved.id);
    const missing = store.forOperation(saved.id, 'team/file', 'download', 'file');
    await removal;
    await expect(missing).rejects.toThrow(/no longer|not found/i);
  });
  it('validates runtime operation arguments and slash boundaries before decrypting credentials', async () => {
    const path = await directory();
    const saved = await new ConnectionStore(path, secure()).save({ ...input, permissions: { download: true, upload: true, delete: true } });
    let decrypts = 0;
    const crypto = secure();
    const store = new ConnectionStore(path, { ...crypto, decrypt: async value => { decrypts++; return crypto.decrypt(value); } });
    for (const id of [null, 1, '', 'missing']) await expect(store.forOperation(id, 'team/file', 'download', 'file')).rejects.toThrow();
    for (const operation of ['', 'copy', '__proto__', null]) await expect(store.forOperation(saved.id, 'team/file', operation as never, 'file')).rejects.toThrow(/operation/i);
    for (const kind of ['', 'directory', null]) await expect(store.forOperation(saved.id, 'team/file', 'download', kind as never)).rejects.toThrow(/kind/i);
    for (const key of [null, 2, '', 'team/', 'team', 'teammate/file', 'outside/file', 'team/a\0b', 'team/' + 'x'.repeat(8192)]) {
      await expect(store.forOperation(saved.id, key, 'download', 'file')).rejects.toThrow(/key|root|outside/i);
    }
    for (const key of ['', 'team', 'team/folder', 'teammate/', 'outside/']) {
      await expect(store.forOperation(saved.id, key, 'download', 'folder')).rejects.toThrow(/key|outside/i);
    }
    await expect(store.forOperation(saved.id, 'team/', 'delete', 'folder')).rejects.toThrow(/root/i);
    expect(decrypts).toBe(0);
  });
  it('preserves opaque object keys and folder prefixes without path normalization', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save({ ...input, permissions: { download: true, upload: true, delete: true } });
    for (const operation of ['download', 'upload', 'delete'] as const) {
      for (const key of ['team/a//../b\\c%20?x#z', 'team/../outside', 'team/ leading and trailing ']) {
        expect((await store.forOperation(saved.id, key, operation, 'file')).key).toBe(key);
        expect((await store.forOperation(saved.id, `${key}/`, operation, 'folder')).key).toBe(`${key}/`);
      }
    }
    expect((await store.forOperation(saved.id, 'team/', 'download', 'folder')).key).toBe('team/');
    expect((await store.forOperation(saved.id, 'team/', 'upload', 'folder')).key).toBe('team/');
  });
  it('allows bucket-root folder download/upload while always protecting root deletion', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save({ ...input, prefix: '', permissions: { download: true, upload: true, delete: true } });
    for (const operation of ['download', 'upload'] as const) expect((await store.forOperation(saved.id, '', operation, 'folder')).key).toBe('');
    for (const operation of ['download', 'upload', 'delete'] as const) await expect(store.forOperation(saved.id, '', operation, 'file')).rejects.toThrow(/key|root/i);
    await expect(store.forOperation(saved.id, '', 'delete', 'folder')).rejects.toThrow(/root/i);
    expect((await store.forOperation(saved.id, '/', 'delete', 'folder')).key).toBe('/');
  });
  it('normalizes permission defaults and rejects malformed permission settings', () => {
    expect(normalizeConnection(input).permissions).toEqual({ download: true, upload: false, delete: false });
    expect(normalizeConnection({ ...input, permissions: { upload: true } }).permissions).toEqual({ download: true, upload: true, delete: false });
    for (const permissions of [null, [], true, 'yes', { download: 'false' }, { upload: 1 }, { delete: null }]) {
      expect(() => normalizeConnection({ ...input, permissions })).toThrow(/permission/i);
    }
  });
  it('loads old connections with permission defaults and persists normalized settings', async () => {
    const path = await directory();
    const original = await new ConnectionStore(path, secure()).save(input);
    const legacy = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8'));
    delete legacy.connections[0].permissions;
    await writeFile(join(path, 'connections.json'), JSON.stringify(legacy));
    const reloaded = new ConnectionStore(path, secure());
    expect((await reloaded.connectionDetails(original.id)).permissions).toEqual({ download: true, upload: false, delete: false });
    await reloaded.save({ ...input, id: original.id, accessKey: '', secretKey: '', permissions: { upload: true } });
    expect(JSON.parse(await readFile(join(path, 'connections.json'), 'utf8')).connections[0].permissions).toEqual({ download: true, upload: true, delete: false });
  });
  it('preserves independent permission settings across copy, edits and restart without changing credentials', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const permissions = { download: false, upload: true, delete: true };
    const saved = await store.save({ ...input, permissions, sessionToken: 'PRIVATE_TOKEN' });
    permissions.download = true;
    expect(saved.permissions).toEqual({ download: false, upload: true, delete: true });
    const copied = await store.copy(saved.id);
    copied.permissions!.upload = false;
    saved.permissions!.delete = false;
    (await store.connectionDetails(saved.id)).permissions!.download = true;
    expect((await store.connections()).connections.map(item => item.permissions)).toEqual([
      { download: false, upload: true, delete: true }, { download: false, upload: true, delete: true },
    ]);
    await store.save({ ...input, id: saved.id, accessKey: '', secretKey: '', permissions: { download: true, upload: false, delete: false } });
    const reloaded = new ConnectionStore(path, secure());
    expect((await reloaded.connectionDetails(copied.id)).permissions).toEqual({ download: false, upload: true, delete: true });
    expect((await reloaded.forListing(copied.id, 'team/')).connection).toMatchObject({ accessKey: input.accessKey, secretKey: input.secretKey, sessionToken: 'PRIVATE_TOKEN' });
  });
  it('persists, edits, copies and forwards extra Config options independently of caller-owned objects', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const extraConfig = { s3: { addressing_style: 'virtual' }, retries: { mode: 'adaptive' } };
    const saved = await store.save({ ...input, extraConfig });
    extraConfig.s3.addressing_style = 'path';
    expect(saved.extraConfig).toEqual({ s3: { addressing_style: 'virtual' }, retries: { mode: 'adaptive' } });
    const copied = await store.copy(saved.id);
    const reloaded = new ConnectionStore(path, secure());
    expect((await reloaded.connectionDetails(saved.id)).extraConfig).toEqual(saved.extraConfig);
    expect((await reloaded.forListing(copied.id, copied.prefix)).connection.extraConfig).toEqual(saved.extraConfig);
    await reloaded.save({ ...input, id: saved.id, accessKey: '', secretKey: '', extraConfig: { s3: { addressing_style: 'path' } } });
    expect((await reloaded.connectionDetails(copied.id)).extraConfig).toEqual(saved.extraConfig);
    await expect(store.save({ ...input, extraConfig: [] })).rejects.toThrow(/extra config/i);
  });
  it('copies every setting and credential, including a null region and session token, into an independent connection', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const source = await store.save({ ...input, prefix: 'raw//../', region: null, sessionToken: 'PRIVATE_TOKEN' });
    const copied = await store.copy(source.id);
    expect(copied.id).not.toBe(source.id);
    expect(copied.name).toBe('Warehouse (copy)');
    const { id: _sourceId, name: _sourceName, ...sourceSettings } = source;
    const { id: _copyId, name: _copyName, ...copiedSettings } = copied;
    expect(copiedSettings).toEqual(sourceSettings);
    expect(await store.forListing(copied.id, copied.prefix)).toEqual(await store.forListing(source.id, source.prefix));

    await store.save({ ...input, id: source.id, accessKey: 'REPLACED_AK', secretKey: 'REPLACED_SK' });
    await store.remove(source.id);
    const reloaded = new ConnectionStore(path, secure());
    expect((await reloaded.forListing(copied.id, copied.prefix)).connection).toMatchObject({ accessKey: input.accessKey, secretKey: input.secretKey, sessionToken: 'PRIVATE_TOKEN', prefix: 'raw//../' });
    expect((await reloaded.connections()).connections[0].region).toBeNull();
    const disk = await readFile(join(path, 'connections.json'), 'utf8');
    expect(disk).not.toContain('TOP_SECRET');
    expect(disk).not.toContain('PRIVATE_TOKEN');
    expect(copied).not.toHaveProperty('secretKey');
  });
  it('assigns unique names to concurrent copies and keeps long names reloadable', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const source = await store.save(input);
    const copies = await Promise.all(Array.from({ length: 3 }, () => store.copy(source.id)));
    expect(copies.map(item => item.name)).toEqual(['Warehouse (copy)', 'Warehouse (copy 2)', 'Warehouse (copy 3)']);
    const long = await store.save({ ...input, name: 'A'.repeat(200) });
    expect((await store.copy(long.id)).name.length).toBeLessThanOrEqual(200);
    expect((await new ConnectionStore(path, secure()).connections()).connections).toHaveLength(6);
    await expect(store.copy('missing')).rejects.toThrow(/no longer|not found/i);
  });
  it('copies session-only credentials without writing them to disk', async () => {
    const path = await directory();
    const unavailable = { ...secure(), isAvailable: async () => false };
    const store = new ConnectionStore(path, unavailable);
    const source = await store.save({ ...input, sessionToken: 'PRIVATE_TOKEN' });
    const copied = await store.copy(source.id);
    await store.remove(source.id);
    expect(copied.hasCredentials).toBe(true);
    expect((await store.forListing(copied.id, copied.prefix)).connection).toMatchObject({ accessKey: input.accessKey, secretKey: input.secretKey, sessionToken: 'PRIVATE_TOKEN' });
    const disk = await readFile(join(path, 'connections.json'), 'utf8');
    expect(disk).not.toContain('TOP_SECRET');
    expect(disk).not.toContain('PRIVATE_TOKEN');
  });
  it('copies encrypted configuration even when credentials are temporarily locked', async () => {
    const path = await directory();
    const source = await new ConnectionStore(path, secure()).save(input);
    const locked = new ConnectionStore(path, { ...secure(), decrypt: async () => { throw new Error('locked'); } });
    await locked.connectionDetails(source.id);
    const copied = await locked.copy(source.id);
    expect(copied.hasCredentials).toBe(false);
    expect((await new ConnectionStore(path, secure()).connectionDetails(copied.id)).secretKey).toBe(input.secretKey);
  });
  it('recovers configured AK and SK for editing without exposing them in ordinary metadata or on disk', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save({ ...input, region: 'eu-west-2', sessionToken: 'PRIVATE_TOKEN' });
    const details = await new ConnectionStore(path, secure()).connectionDetails(saved.id);
    expect(details).toMatchObject({ id: saved.id, region: 'eu-west-2', accessKey: input.accessKey, secretKey: input.secretKey, hasCredentials: true });
    expect(saved).not.toHaveProperty('secretKey');
    expect((await store.connections()).connections[0]).not.toHaveProperty('secretKey');
    expect(details).not.toHaveProperty('sessionToken');
    expect(details).not.toHaveProperty('encryptedCredentials');
    const disk = await readFile(join(path, 'connections.json'), 'utf8');
    expect(disk).not.toContain(input.accessKey);
    expect(disk).not.toContain(input.secretKey);
  });
  it('retains null on disk and in edit details while applying the default only to S3 requests', async () => {
    const path = await directory();
    const saved = await new ConnectionStore(path, secure()).save({ ...input, region: null });
    const reloaded = new ConnectionStore(path, secure());
    expect((await reloaded.connectionDetails(saved.id)).region).toBeNull();
    expect((await reloaded.connections()).connections[0].region).toBeNull();
    expect(JSON.parse(await readFile(join(path, 'connections.json'), 'utf8')).connections[0].region).toBeNull();
    expect((await reloaded.forListing(saved.id, 'team/')).connection.region).toBe('us-east-1');
  });
  it('keeps editing available when saved credentials cannot be recovered', async () => {
    const path = await directory();
    const unavailable = { ...secure(), isAvailable: async () => false };
    const store = new ConnectionStore(path, unavailable);
    const saved = await store.save(input);
    expect((await store.connectionDetails(saved.id)).accessKey).toBe(input.accessKey);
    expect((await store.connectionDetails(saved.id)).secretKey).toBe(input.secretKey);
    expect(await new ConnectionStore(path, unavailable).connectionDetails(saved.id)).toMatchObject({ accessKey: '', secretKey: '', hasCredentials: false, region: null });
    await expect(store.connectionDetails('missing')).rejects.toThrow(/no longer|not found/i);
  });
  it('preserves the saved SK and token when the prefilled AK is unchanged', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save({ ...input, sessionToken: 'PRIVATE_TOKEN' });
    await store.save({ ...input, id: saved.id, name: 'Edited', secretKey: '', sessionToken: '', region: null });
    expect((await store.forListing(saved.id, 'team/')).connection).toMatchObject({ accessKey: input.accessKey, secretKey: input.secretKey, sessionToken: 'PRIVATE_TOKEN' });
    await expect(store.save({ ...input, id: saved.id, accessKey: 'DIFFERENT_AK', secretKey: '' })).rejects.toThrow(/secret key/i);
    expect((await store.connectionDetails(saved.id)).accessKey).toBe(input.accessKey);
  });
  it('encrypts saved credentials and recovers them without exposing secrets in metadata', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save(input);
    expect(saved).toMatchObject({ hasCredentials: true, prefix: 'team/' });
    expect(saved).not.toHaveProperty('secretKey');
    const disk = await readFile(join(path, 'connections.json'), 'utf8');
    expect(disk).not.toContain(input.secretKey);
    expect(disk).not.toContain(input.accessKey);
    const reloaded = new ConnectionStore(path, secure());
    expect((await reloaded.forListing(saved.id, 'team/folder')).connection).toMatchObject({ accessKey: input.accessKey, secretKey: input.secretKey, prefix: 'team/' });
  });
  it('keeps credentials only in memory when encryption is unavailable', async () => {
    const path = await directory();
    const unavailable: SecretStorage = { ...secure(), isAvailable: async () => false };
    const store = new ConnectionStore(path, unavailable);
    const saved = await store.save(input);
    expect((await store.connections()).secureStorage).toBe(false);
    expect((await store.forListing(saved.id, 'team/')).connection.secretKey).toBe(input.secretKey);
    const disk = await readFile(join(path, 'connections.json'), 'utf8');
    expect(disk).not.toContain('TOP_SECRET');
    expect(disk).not.toContain('encryptedCredentials');
    const reloaded = new ConnectionStore(path, unavailable);
    expect((await reloaded.connections()).connections[0].hasCredentials).toBe(false);
    await expect(reloaded.forListing(saved.id, 'team/')).rejects.toThrow(/reconnect|re-enter/i);
  });
  it('preserves credentials when editing with blank keys and removes connections durably', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const saved = await store.save({ ...input, sessionToken: 'token' });
    await store.save({ ...input, id: saved.id, name: 'Renamed', accessKey: '', secretKey: '', sessionToken: '' });
    expect((await store.forListing(saved.id, 'team/')).connection).toMatchObject({ accessKey: input.accessKey, secretKey: input.secretKey, sessionToken: 'token' });
    await store.remove(saved.id);
    expect((await new ConnectionStore(path, secure()).connections()).connections).toEqual([]);
    await expect(store.forListing(saved.id, 'team/')).rejects.toThrow(/no longer|not found/i);
  });
  it('rejects partial credential replacements and never falls back to plaintext after encryption failure', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, { ...secure(), encrypt: async () => { throw new Error('crypto failed'); } });
    await expect(store.save({ ...input, secretKey: '' })).rejects.toThrow(/both|access.*secret/i);
    await expect(store.save(input)).rejects.toThrow(/encrypt|secure/i);
    expect((await store.connections()).connections).toEqual([]);
  });
  it('serializes concurrent persistence and leaves one valid atomic JSON snapshot', async () => {
    const path = await directory();
    const crypto = secure();
    crypto.encrypt = async value => { await new Promise(resolve => setTimeout(resolve, 10)); return Buffer.from(value).reverse(); };
    const store = new ConnectionStore(path, crypto);
    const saved = await Promise.all(Array.from({ length: 12 }, (_, i) => store.save({ ...input, name: `connection-${i}` })));
    await Promise.all(saved.slice(0, 6).map(connection => store.remove(connection.id)));
    const reloaded = new ConnectionStore(path, secure());
    expect((await reloaded.connections()).connections.map(c => c.name)).toEqual(saved.slice(6).map(c => c.name));
    expect(JSON.parse(await readFile(join(path, 'connections.json'), 'utf8')).connections).toHaveLength(6);
  });
  it('locks only the failed encrypted connection and permits replacing its credentials', async () => {
    const path = await directory();
    const store = new ConnectionStore(path, secure());
    const first = await store.save(input);
    const second = await store.save({ ...input, name: 'Other' });
    const data = JSON.parse(await readFile(join(path, 'connections.json'), 'utf8'));
    data.connections[0].encryptedCredentials = Buffer.from('broken').toString('base64');
    await writeFile(join(path, 'connections.json'), JSON.stringify(data));
    const reloaded = new ConnectionStore(path, secure());
    await expect(reloaded.forListing(first.id, 'team/')).rejects.toThrow(/reconnect|re-enter/i);
    expect((await reloaded.connections()).connections.find(c => c.id === first.id)?.hasCredentials).toBe(false);
    expect((await reloaded.forListing(second.id, 'team/')).connection.secretKey).toBe(input.secretKey);
    await reloaded.save({ ...input, id: first.id });
    expect((await reloaded.forListing(first.id, 'team/')).connection.secretKey).toBe(input.secretKey);
  });
});
