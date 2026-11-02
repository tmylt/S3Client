export interface UriConnection { bucket: string; uriScheme?: string }

export function connectionUriScheme(connection: Pick<UriConnection, 'uriScheme'>): string {
  return connection.uriScheme?.trim().toLowerCase() || 's3';
}

export function storageUri(connection: UriConnection, key: string): string {
  return `${connectionUriScheme(connection)}://${connection.bucket}/${key}`;
}

export function uriLabel(connection: Pick<UriConnection, 'uriScheme'>): string {
  return `${connectionUriScheme(connection).toUpperCase()} URI`;
}

export function isConnectionUri(value: string, uriScheme?: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value)?.[1].toLowerCase();
  return scheme === 's3' || scheme === connectionUriScheme({ uriScheme });
}
