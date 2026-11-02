import type { Connection } from './types';

export interface ConnectionUri { uriScheme: string; bucket: string; key: string }

/** Preserve S3 keys exactly: percent signs, repeated slashes, and dot segments are data. */
export function parseConnectionUri(value: string): ConnectionUri | null {
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]+)(?:\/(.*))?$/is.exec(value);
  if (!match || /[\s\\?#\0]/.test(match[2]) || value.includes('\0')) return null;
  return { uriScheme: match[1].toLowerCase(), bucket: match[2], key: match[3] ?? '' };
}

function segments(key: string): string[] {
  if (!key) return [];
  const parts = key.split('/');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}

export function matchConnectionUri(value: string, connections: readonly Connection[]): (ConnectionUri & { connection: Connection }) | null {
  const uri = parseConnectionUri(value);
  if (!uri) return null;
  const target = segments(uri.key);
  let best: { connection: Connection; priority: number; common: number } | undefined;
  for (const connection of connections) {
    if ((connection.uriScheme || 's3').toLowerCase() !== uri.uriScheme || connection.bucket !== uri.bucket) continue;
    const root = segments(connection.prefix);
    let common = 0;
    while (common < target.length && common < root.length && target[common] === root[common]) common++;
    const priority = uri.key.startsWith(connection.prefix) ? 1 : 0;
    if (!best || priority > best.priority || priority === best.priority && common > best.common) best = { connection, priority, common };
  }
  return best ? { ...uri, connection: best.connection } : null;
}
