import { describe, expect, it } from 'vitest';
import { matchConnectionUri, parseConnectionUri } from '../src/shared/connection-uri-search';
import type { Connection } from '../src/shared/types';

const connection = (id: string, prefix: string, uriScheme = 's3', bucket = 'bucket'): Connection => ({
  id, name: id, endpoint: 'https://example.com', bucket, uriScheme, prefix,
  region: null, hasCredentials: true,
});

describe('connection URI search', () => {
  it('parses opaque S3 keys and folder URIs without decoding them', () => {
    expect(parseConnectionUri('obs://bucket/a (6)+/%2F/')).toEqual({ uriScheme: 'obs', bucket: 'bucket', key: 'a (6)+/%2F/' });
    expect(parseConnectionUri('s3://bucket/a ')).toEqual({ uriScheme: 's3', bucket: 'bucket', key: 'a ' });
    expect(parseConnectionUri('s3://bucket')).toEqual({ uriScheme: 's3', bucket: 'bucket', key: '' });
    expect(parseConnectionUri('not a URI')).toBeNull();
    expect(parseConnectionUri('s3:///a')).toBeNull();
  });

  it('requires matching URI scheme and bucket', () => {
    expect(matchConnectionUri('obs://bucket/a', [connection('s3', ''), connection('other', '', 'obs', 'other')])).toBeNull();
    expect(matchConnectionUri('OBS://bucket/a', [connection('obs', '', 'obs')])?.connection.id).toBe('obs');
  });

  it('prefers a containing prefix over a closer partial match', () => {
    const result = matchConnectionUri('s3://bucket/ap/bsfa/cds/das', [
      connection('partial', 'ap/bsfa/cds/other/'),
      connection('ancestor', 'ap/'),
      connection('root', ''),
    ]);
    expect(result?.connection.id).toBe('ancestor');
  });

  it('ranks shared directory segments for descendant and partial prefixes', () => {
    const result = matchConnectionUri('s3://bucket/ap/bsfa/cds/das', [
      connection('one-segment', 'ap/other/'),
      connection('partial', 'ap/bsfa/other/'),
      connection('descendant', 'ap/bsfa/cds/das/child/'),
    ]);
    expect(result?.connection.id).toBe('descendant');
  });

  it('keeps connection order when priority and segment count tie', () => {
    const connections = [connection('first', 'ap/bsfa/one/'), connection('second', 'ap/bsfa/two/')];
    expect(matchConnectionUri('s3://bucket/ap/bsfa/cds/das', connections)?.connection.id).toBe('first');
    expect(matchConnectionUri('s3://bucket/ap/bsfa/cds/das', [...connections].reverse())?.connection.id).toBe('second');
  });

  it('compares whole directory segments, not string prefixes', () => {
    expect(matchConnectionUri('s3://bucket/ap/bsfa/cds', [connection('partial-name', 'ap/bsf/'), connection('full-segment', 'ap/bsfa/other/')])?.connection.id).toBe('full-segment');
  });

  it('does not treat a folder prefix as containing a file key with the same text', () => {
    expect(matchConnectionUri('s3://bucket/ap/file', [connection('same-name-folder', 'ap/file/'), connection('ancestor', 'ap/')])?.connection.id).toBe('ancestor');
  });
});
