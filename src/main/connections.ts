import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection, ConnectionDetails, ConnectionInput, ConnectionPermissions, Credentials } from '../shared/types';
import { normalizeExtraConfig } from '../shared/extra-config';
import { connectionPermissions } from '../shared/permissions';
import { defaultPageSize, isPageSize } from '../shared/page-size';
import { isConnectionUri } from '../shared/storage-uri';

/** Kept separate from Electron so persistence can be exercised against real files. */
export interface SecretStorage {
  isAvailable(): Promise<boolean>;
  encrypt(value: string): Promise<Buffer>;
  decrypt(value: Buffer): Promise<string>;
}

interface StoredConnection extends Omit<Connection, 'hasCredentials'> { encryptedCredentials?: string }
export interface WorkerConnection extends Omit<Connection, 'id' | 'name' | 'hasCredentials' | 'region'>, Credentials { region: string }
const reconnectMessage = 'Credentials are unavailable. Edit this connection and re-enter both access key and secret key to reconnect.';

function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new Error(`Invalid ${label}.`);
  return value;
}

/** S3 keys are not filesystem paths: never resolve dots, slashes or backslashes. */
export function directoryPrefix(value: string): string { return value && !value.endsWith('/') ? `${value}/` : value; }

export function validatePrefix(root: string, value: unknown): string {
  const prefix = directoryPrefix(string(value, 'folder prefix', 8192));
  if (!prefix.startsWith(root)) throw new Error('This folder is outside the configured connection prefix.');
  return prefix;
}

function normalizePermissions(value: unknown): ConnectionPermissions {
  if (value === undefined) return connectionPermissions();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid connection permissions.');
  const permissions = value as Partial<ConnectionPermissions>;
  for (const operation of ['download', 'upload', 'delete'] as const) {
    if (permissions[operation] !== undefined && typeof permissions[operation] !== 'boolean') throw new Error('Connection permissions must be boolean values.');
  }
  return connectionPermissions(permissions);
}

export function normalizeConnection(value: unknown): Omit<StoredConnection, 'id' | 'encryptedCredentials'> {
  if (!value || typeof value !== 'object') throw new Error('Invalid connection.');
  const input = value as ConnectionInput;
  const name = string(input.name, 'connection name', 200).trim();
  if (!name) throw new Error('A connection name is required.');
  const endpoint = string(input.endpoint, 'endpoint').trim();
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error('Enter a valid HTTP or HTTPS endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('The endpoint must be an HTTP or HTTPS URL without credentials, query, or fragment.');
  }
  const legacyProvider = (value as { provider?: unknown }).provider;
  const uriScheme = string(input.uriScheme ?? legacyProvider ?? 's3', 'URI scheme', 32).trim().toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(uriScheme)) throw new Error('URI scheme must be a scheme such as s3, obs, or oss.');
  let bucket = string(input.bucket, 'bucket', 8192);
  let prefix = string(input.prefix ?? '', 'prefix', 8192);
  const uri = isConnectionUri(prefix, uriScheme) ? prefix : isConnectionUri(bucket, uriScheme) ? bucket : undefined;
  if (uri) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)(?:\/(.*))?$/is.exec(uri);
    if (!match) throw new Error(`Enter a URI such as ${uriScheme}://bucket/path.`);
    bucket = match[1]; prefix = match[2] ?? '';
  } else bucket = bucket.trim();
  if (!bucket || /[\s/\\?#\0]/.test(bucket) || bucket.length > 255) throw new Error('Enter a valid bucket name without slashes.');
  const region = string(input.region ?? '', 'region', 200).trim() || null;
  const pageSize = input.defaultPageSize === undefined ? defaultPageSize : input.defaultPageSize;
  if (!isPageSize(pageSize)) throw new Error('Choose a valid default page size.');
  return { name, endpoint: url.href.replace(/\/$/, ''), bucket, uriScheme, prefix: directoryPrefix(prefix), region, defaultPageSize: pageSize, extraConfig: normalizeExtraConfig(input.extraConfig), permissions: normalizePermissions(input.permissions) };
}

function parseCredentials(value: unknown): Credentials {
  if (!value || typeof value !== 'object') throw new Error(reconnectMessage);
  const credentials = value as Credentials;
  const accessKey = string(credentials.accessKey, 'access key', 8192);
  const secretKey = string(credentials.secretKey, 'secret key', 8192);
  if (!accessKey || !secretKey) throw new Error(reconnectMessage);
  const sessionToken = credentials.sessionToken === undefined ? undefined : string(credentials.sessionToken, 'session token', 32768);
  return { accessKey, secretKey, ...(sessionToken ? { sessionToken } : {}) };
}

export class ConnectionStore {
  private readonly file: string;
  private loaded = false;
  private records: StoredConnection[] = [];
  private readonly credentials = new Map<string, Credentials>();
  private readonly locked = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string, private readonly storage: SecretStorage) {
    this.file = join(directory, 'connections.json');
  }

  /** Encryption, mutation and atomic rename share a queue to prevent lost updates. */
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => { await this.load(); return operation(); });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async available(): Promise<boolean> {
    try { return await this.storage.isAvailable(); } catch { return false; }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    let raw: string;
    try { raw = await readFile(this.file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.loaded = true; return; } throw new Error('Could not read saved connections. Check access to the application data directory.'); }
    let migrateUriSchemes = false;
    try {
      const data = JSON.parse(raw) as { version: number; connections: unknown[] };
      if (data.version !== 1 || !Array.isArray(data.connections)) throw new Error();
      const ids = new Set<string>();
      this.records = data.connections.map(value => {
        const item = value as StoredConnection;
        if (!Object.prototype.hasOwnProperty.call(item, 'uriScheme') || Object.prototype.hasOwnProperty.call(item, 'provider')) migrateUriSchemes = true;
        const id = string(item.id, 'connection ID', 200);
        if (!id || ids.has(id)) throw new Error();
        ids.add(id);
        const settings = normalizeConnection(item);
        const encryptedCredentials = item.encryptedCredentials === undefined ? undefined : string(item.encryptedCredentials, 'encrypted credentials', 131072);
        return { id, ...settings, ...(encryptedCredentials ? { encryptedCredentials } : {}) };
      });
    } catch { throw new Error('Saved connections could not be read. Restore or rename connections.json in the application data directory.'); }
    if (migrateUriSchemes) {
      // Reading a profile must still work when its data directory is read-only.
      await this.persist(this.records).catch(() => undefined);
    }
    this.loaded = true;
  }

  private public(record: StoredConnection): Connection {
    const { encryptedCredentials, ...metadata } = record;
    return { ...metadata, extraConfig: normalizeExtraConfig(record.extraConfig), permissions: connectionPermissions(record.permissions), hasCredentials: this.credentials.has(record.id) || Boolean(encryptedCredentials && !this.locked.has(record.id)) };
  }

  private async persist(records: StoredConnection[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, connections: records }, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
    } catch { throw new Error('Could not save connections. Check access to the application data directory.'); }
    finally { await unlink(temporary).catch(() => undefined); }
  }

  connections(): Promise<{ connections: Connection[]; secureStorage: boolean }> {
    return this.serial(async () => {
      const secureStorage = await this.available();
      if (!secureStorage) this.records.forEach(record => { if (!this.credentials.has(record.id)) this.locked.add(record.id); });
      return { connections: this.records.map(record => this.public(record)), secureStorage };
    });
  }

  reorder(value: unknown): Promise<void> {
    return this.serial(async () => {
      if (!Array.isArray(value) || value.length !== this.records.length) throw new Error('Invalid connection order.');
      const byId = new Map(this.records.map(record => [record.id, record]));
      const next: StoredConnection[] = [];
      for (const id of value) {
        const record = typeof id === 'string' ? byId.get(id) : undefined;
        if (!record) throw new Error('Invalid connection order.');
        next.push(record);
        byId.delete(id);
      }
      await this.persist(next);
      this.records = next;
    });
  }

  connectionDetails(value: unknown): Promise<ConnectionDetails> {
    return this.serial(async () => {
      const id = string(value, 'connection ID', 200);
      const record = this.records.find(item => item.id === id);
      if (!record) throw new Error('This connection no longer exists.');
      let accessKey = '';
      let secretKey = '';
      try { ({ accessKey, secretKey } = await this.unlock(record)); }
      catch { /* An unavailable key store must still allow editing and reconnecting. */ }
      return { ...this.public(record), accessKey, secretKey };
    });
  }

  save(value: unknown): Promise<Connection> {
    return this.serial(async () => {
      const settings = normalizeConnection(value);
      const input = value as ConnectionInput;
      const id = input.id === undefined ? randomUUID() : string(input.id, 'connection ID', 200);
      const previous = this.records.find(record => record.id === id);
      if (input.id !== undefined && !previous) throw new Error('This connection no longer exists.');
      const accessKey = input.accessKey === undefined ? '' : string(input.accessKey, 'access key', 8192);
      const secretKey = input.secretKey === undefined ? '' : string(input.secretKey, 'secret key', 8192);
      let credentials: Credentials;
      if (accessKey && secretKey) credentials = parseCredentials({ accessKey, secretKey, sessionToken: input.sessionToken });
      else if (previous && !secretKey) {
        credentials = await this.unlock(previous);
        if (accessKey && accessKey !== credentials.accessKey) throw new Error('Enter the secret key when changing the access key.');
      }
      else throw new Error('Enter both access key and secret key.');
      const record: StoredConnection = { id, ...settings };
      if (await this.available()) {
        try { record.encryptedCredentials = (await this.storage.encrypt(JSON.stringify(credentials))).toString('base64'); }
        catch { throw new Error('Secure credential encryption failed. The connection was not saved.'); }
      }
      const next = previous ? this.records.map(item => item.id === id ? record : item) : [...this.records, record];
      await this.persist(next);
      this.records = next;
      this.credentials.set(id, credentials);
      this.locked.delete(id);
      return this.public(record);
    });
  }

  copy(value: unknown): Promise<Connection> {
    return this.serial(async () => {
      const sourceId = string(value, 'connection ID', 200);
      const source = this.records.find(item => item.id === sourceId);
      if (!source) throw new Error('This connection no longer exists.');
      let name: string;
      let number = 1;
      do {
        const suffix = number === 1 ? ' (copy)' : ` (copy ${number})`;
        name = source.name.slice(0, 200 - suffix.length).trimEnd() + suffix;
        number++;
      } while (this.records.some(item => item.name === name));
      // Encrypted credentials can be duplicated without prompting the key store.
      const record: StoredConnection = { ...source, id: randomUUID(), name, extraConfig: normalizeExtraConfig(source.extraConfig), permissions: connectionPermissions(source.permissions) };
      const next = [...this.records, record];
      await this.persist(next);
      this.records = next;
      const credentials = this.credentials.get(sourceId);
      if (credentials) this.credentials.set(record.id, { ...credentials });
      if (this.locked.has(sourceId)) this.locked.add(record.id);
      return this.public(record);
    });
  }

  remove(value: unknown): Promise<void> {
    return this.serial(async () => {
      const id = string(value, 'connection ID', 200);
      const next = this.records.filter(record => record.id !== id);
      await this.persist(next);
      this.records = next;
      this.credentials.delete(id);
      this.locked.delete(id);
    });
  }

  private async unlock(record: StoredConnection): Promise<Credentials> {
    const cached = this.credentials.get(record.id);
    if (cached) return cached;
    if (this.locked.has(record.id) || !record.encryptedCredentials || !await this.available()) {
      this.locked.add(record.id);
      throw new Error(reconnectMessage);
    }
    try {
      const decoded = await this.storage.decrypt(Buffer.from(record.encryptedCredentials, 'base64'));
      const credentials = parseCredentials(JSON.parse(decoded));
      this.credentials.set(record.id, credentials);
      return credentials;
    } catch {
      this.locked.add(record.id);
      throw new Error(reconnectMessage);
    }
  }

  forListing(value: unknown, requestedPrefix: unknown): Promise<{ connection: WorkerConnection; prefix: string }> {
    return this.serial(async () => {
      const id = string(value, 'connection ID', 200);
      const record = this.records.find(item => item.id === id);
      if (!record) throw new Error('This connection no longer exists.');
      const prefix = validatePrefix(record.prefix, requestedPrefix);
      const credentials = await this.unlock(record);
      return { connection: { endpoint: record.endpoint, bucket: record.bucket, uriScheme: record.uriScheme, prefix: record.prefix, region: record.region ?? 'us-east-1', extraConfig: normalizeExtraConfig(record.extraConfig), ...credentials }, prefix };
    });
  }

  forOperation(value: unknown, requestedKey: unknown, operation: 'download' | 'upload' | 'delete', kind: 'file' | 'folder'): Promise<{ connection: WorkerConnection; key: string; connectionName: string }> {
    return this.serial(async () => {
      const id = string(value, 'connection ID', 200);
      const record = this.records.find(item => item.id === id);
      if (!record) throw new Error('This connection no longer exists.');
      if (!['download', 'upload', 'delete'].includes(operation)) throw new Error('Invalid operation.');
      if (kind !== 'file' && kind !== 'folder') throw new Error('Invalid operation kind.');
      if (!connectionPermissions(record.permissions)[operation]) throw new Error(`The ${operation} operation is not allowed by this connection's permissions.`);

      // A key is opaque S3 data. Require folder delimiters without adding or resolving them.
      const key = string(requestedKey, 'object key', 8192);
      if (operation === 'delete' && key === record.prefix) throw new Error('The configured connection root cannot be deleted.');
      if (kind === 'file' && (!key || key.endsWith('/') || key === record.prefix)) throw new Error('Invalid file key.');
      if (kind === 'folder' && (key ? !key.endsWith('/') : Boolean(record.prefix))) throw new Error('Invalid folder key.');
      if (!key.startsWith(record.prefix)) throw new Error('This key is outside the configured connection prefix.');

      const credentials = await this.unlock(record);
      return {
        connection: { endpoint: record.endpoint, bucket: record.bucket, uriScheme: record.uriScheme, prefix: record.prefix, region: record.region ?? 'us-east-1', extraConfig: normalizeExtraConfig(record.extraConfig), ...credentials },
        key,
        connectionName: record.name,
      };
    });
  }
}
